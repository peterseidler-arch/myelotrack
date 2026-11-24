import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { computeFlag } from '../../data/seed.js';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * PostgreSQL repository (Cloud SQL for PostgreSQL in production). Implements
 * the same interface as the memory repository.
 *
 * Every patient-scoped call runs in its own transaction that first sets the
 * transaction-local `app.user_id`; row-level security on each PHI table (see
 * migrations/001_init.sql) then limits the transaction to that patient's rows.
 * Queries also filter by user_id explicitly, so RLS is a second wall, not the
 * only one.
 *
 * @param {{ connectionString?: string, pool?: pg.Pool, migrate?: boolean }} opts
 */
export async function createPostgresRepository({
  connectionString,
  pool: providedPool,
  migrate = true,
} = {}) {
  const pool = providedPool || new pg.Pool({ connectionString });
  if (migrate) await runMigrations(pool);

  /** Run fn(client) inside a transaction bound to one patient. */
  async function asPatient(userId, fn) {
    if (!userId) throw new Error('repository: a userId is required for PHI access');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const one = async (q, params) => (await pool.query(q, params)).rows[0] || null;

  return {
    kind: 'postgres',
    pool,

    forUser(userId) {
      return createPatientScope(userId, asPatient);
    },

    /**
     * True when the connected role can see past row-level security (superuser
     * or BYPASSRLS). Patient isolation then rests on query filters alone.
     */
    async bypassesRowSecurity() {
      const r = await one(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      return Boolean(r?.rolsuper || r?.rolbypassrls);
    },

    async close() {
      if (!providedPool) await pool.end();
    },

    // --- Users ---
    async createUser({ displayName = '' } = {}) {
      return mapUser(
        await one('INSERT INTO users (id, display_name) VALUES ($1, $2) RETURNING *', [
          `u_${randomUUID()}`,
          displayName,
        ]),
      );
    },
    /** Create a user with a fixed id if missing (local dev subject only). */
    async ensureUser(userId) {
      await pool.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [
        userId,
      ]);
    },
    async getUser(userId) {
      return mapUser(await one('SELECT * FROM users WHERE id = $1', [userId]));
    },
    async countUsers() {
      return Number((await one('SELECT count(*)::int AS n FROM users')).n);
    },
    /** Removes the user, their passkeys, password login and (by cascade) all their PHI. */
    async deleteUser(userId) {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    },

    // --- Passkey credentials ---
    async listCredentials(userId) {
      const { rows } = await pool.query(
        'SELECT * FROM passkey_credentials WHERE user_id = $1 ORDER BY created_at',
        [userId],
      );
      return rows.map(mapCredential);
    },
    async countCredentials() {
      return Number((await one('SELECT count(*)::int AS n FROM passkey_credentials')).n);
    },
    async getCredential(id) {
      if (!id) return null;
      return mapCredential(
        await one('SELECT * FROM passkey_credentials WHERE id = $1', [id]),
      );
    },
    async addCredential(userId, cred) {
      return mapCredential(
        await one(
          `INSERT INTO passkey_credentials (id, user_id, public_key, counter, transports)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [
            cred.id,
            userId,
            cred.publicKey,
            cred.counter ?? 0,
            json(cred.transports || []),
          ],
        ),
      );
    },
    async updateCredentialCounter(id, counter) {
      await pool.query('UPDATE passkey_credentials SET counter = $2 WHERE id = $1', [
        id,
        counter,
      ]);
    },

    // --- Email + password logins (one per user; email unique) ---
    async getPasswordLogin(email) {
      return mapPasswordLogin(
        await one('SELECT * FROM password_logins WHERE email = $1', [email]),
      );
    },
    async getPasswordLoginForUser(userId) {
      return mapPasswordLogin(
        await one('SELECT * FROM password_logins WHERE user_id = $1', [userId]),
      );
    },
    async countPasswordLogins() {
      return Number((await one('SELECT count(*)::int AS n FROM password_logins')).n);
    },
    /** Create or replace a user's login. Throws EMAIL_TAKEN if another user has the email. */
    async setPasswordLogin(userId, { email, passwordHash }) {
      try {
        return mapPasswordLogin(
          await one(
            `INSERT INTO password_logins (user_id, email, password_hash)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE
               SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash,
                   updated_at = now()
             RETURNING *`,
            [userId, email, passwordHash],
          ),
        );
      } catch (err) {
        if (err.code === '23505') {
          const taken = new Error('an account with that email already exists');
          taken.code = 'EMAIL_TAKEN';
          throw taken;
        }
        throw err;
      }
    },

    // --- WebAuthn ceremony challenges ---
    async saveChallenge(challenge, { purpose, userId = null }) {
      await pool.query('DELETE FROM auth_challenges WHERE expires_at < now()');
      await pool.query(
        `INSERT INTO auth_challenges (challenge, purpose, user_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [challenge, purpose, userId, new Date(Date.now() + CHALLENGE_TTL_MS)],
      );
    },
    async consumeChallenge(challenge, purpose) {
      const row = await one(
        'DELETE FROM auth_challenges WHERE challenge = $1 RETURNING *',
        [challenge],
      );
      if (!row || row.purpose !== purpose || row.expires_at < new Date()) return null;
      return { purpose: row.purpose, userId: row.user_id };
    },

    // --- Audit (append-only; UPDATE/DELETE are rejected by a trigger) ---
    async recordAudit(entry) {
      const {
        userId = null,
        actor,
        action,
        route,
        status,
        ip,
        userAgent,
        at,
        ...meta
      } = entry;
      await pool.query(
        `INSERT INTO audit_log (user_id, actor, action, route, status, ip, user_agent, meta, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          userId,
          actor,
          action,
          route ?? null,
          status ?? null,
          ip ?? null,
          userAgent ?? null,
          Object.keys(meta).length ? json(meta) : null,
          at || new Date(),
        ],
      );
    },
    async getAuditLog({ userId } = {}) {
      const { rows } = userId
        ? await pool.query('SELECT * FROM audit_log WHERE user_id = $1 ORDER BY id', [
            userId,
          ])
        : await pool.query('SELECT * FROM audit_log ORDER BY id');
      return rows.map((r) => ({
        userId: r.user_id,
        actor: r.actor,
        action: r.action,
        route: r.route,
        status: r.status,
        ip: r.ip,
        userAgent: r.user_agent,
        ...(r.meta || {}),
        at: r.at,
      }));
    },

    computeFlag,
  };
}

/** The PHI surface for one patient; every call is an RLS-bound transaction. */
function createPatientScope(userId, asPatient) {
  const tx = (fn) => asPatient(userId, fn);

  return {
    kind: 'postgres',
    userId,

    // --- Symptoms ---
    listSymptoms({ from, to } = {}) {
      return tx(async (c) => {
        const { rows } = await c.query(
          `SELECT * FROM symptom_entries
           WHERE user_id = $1
             AND ($2::timestamptz IS NULL OR date >= $2)
             AND ($3::timestamptz IS NULL OR date <= $3)
           ORDER BY date DESC`,
          [userId, from || null, to || null],
        );
        return rows.map(mapSymptom);
      });
    },
    upsertSymptomEntry(entry) {
      const date = entry.date ? new Date(entry.date) : new Date();
      const day = date.toISOString().slice(0, 10);
      return tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO symptom_entries (user_id, day, date, items, total, weight_kg, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, day) DO UPDATE SET
             date = EXCLUDED.date, items = EXCLUDED.items, total = EXCLUDED.total,
             weight_kg = EXCLUDED.weight_kg, note = EXCLUDED.note, updated_at = now()
           RETURNING *`,
          [
            userId,
            day,
            date,
            json(entry.items || {}),
            entry.total ?? 0,
            entry.weightKg ?? null,
            entry.note || '',
          ],
        );
        return mapSymptom(rows[0]);
      });
    },

    // --- Medications & doses ---
    listMedications() {
      return tx(async (c) => {
        const { rows } = await c.query(
          'SELECT * FROM medications WHERE user_id = $1 AND active ORDER BY created_at, id',
          [userId],
        );
        return rows.map(mapMedication);
      });
    },
    upsertMedications(meds = []) {
      return tx(async (c) => {
        for (const m of meds) {
          const params = [
            userId,
            m.name,
            m.brand || '',
            m.dose || '',
            m.form ?? null,
            m.purpose || '',
            m.rxnorm ?? null,
            json(m.schedule || {}),
            m.prescriber ? json(m.prescriber) : null,
            m.active ?? true,
            m.source ?? null,
            m.provenance ? json(m.provenance) : null,
            m.provenance?.externalId ?? null,
            m.startedAt ?? null,
            m.stoppedAt ?? null,
            m.trial ? json(m.trial) : null,
          ];
          await c.query(
            `INSERT INTO medications (user_id, name, brand, dose, form, purpose, rxnorm,
               schedule, prescriber, active, source, provenance, external_id,
               started_at, stopped_at, trial)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             ON CONFLICT (user_id, external_id) WHERE external_id IS NOT NULL
             DO UPDATE SET name = EXCLUDED.name, brand = EXCLUDED.brand,
               dose = EXCLUDED.dose, form = EXCLUDED.form, purpose = EXCLUDED.purpose,
               rxnorm = EXCLUDED.rxnorm, schedule = EXCLUDED.schedule,
               prescriber = EXCLUDED.prescriber, active = EXCLUDED.active,
               source = EXCLUDED.source, provenance = EXCLUDED.provenance,
               started_at = EXCLUDED.started_at, stopped_at = EXCLUDED.stopped_at,
               trial = EXCLUDED.trial, updated_at = now()`,
            params,
          );
        }
        return meds.length;
      });
    },
    /** Add one medication (patient-entered). Returns the stored record. */
    createMedication(m) {
      return tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO medications (user_id, name, brand, dose, form, purpose, schedule,
             prescriber, active, source, provenance, external_id, started_at, trial)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [
            userId,
            m.name,
            m.brand || '',
            m.dose || '',
            m.form ?? null,
            m.purpose || '',
            json(m.schedule || {}),
            m.prescriber ? json(m.prescriber) : null,
            m.active ?? true,
            m.source ?? null,
            m.provenance ? json(m.provenance) : null,
            m.provenance?.externalId ?? null,
            m.startedAt ?? null,
            m.trial ? json(m.trial) : null,
          ],
        );
        return mapMedication(rows[0]);
      });
    },
    /** Patch one medication (active or stopped). Returns it, or null if unknown. */
    updateMedication(id, patch) {
      const cols = {
        name: 'name',
        brand: 'brand',
        dose: 'dose',
        purpose: 'purpose',
        schedule: 'schedule',
        prescriber: 'prescriber',
        active: 'active',
        stoppedAt: 'stopped_at',
        provenance: 'provenance',
        trial: 'trial',
      };
      const sets = [];
      const params = [userId, id];
      for (const [key, col] of Object.entries(cols)) {
        if (!(key in patch)) continue;
        let v = patch[key];
        if (['schedule', 'provenance', 'prescriber', 'trial'].includes(key)) {
          v = v == null ? null : json(v);
        }
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
      return tx(async (c) => {
        if (!sets.length) {
          const { rows } = await c.query(
            'SELECT * FROM medications WHERE user_id = $1 AND id = $2',
            [userId, id],
          );
          return rows[0] ? mapMedication(rows[0]) : null;
        }
        const { rows } = await c.query(
          `UPDATE medications SET ${sets.join(', ')}, updated_at = now()
           WHERE user_id = $1 AND id = $2 RETURNING *`,
          params,
        );
        return rows[0] ? mapMedication(rows[0]) : null;
      });
    },
    logDose(medicationId, { status, scheduledFor, takenAt, note } = {}) {
      return tx(async (c) => {
        const med = await c.query(
          'SELECT 1 FROM medications WHERE user_id = $1 AND id = $2',
          [userId, medicationId],
        );
        if (!med.rowCount) return null;
        const s = status || 'taken';
        const { rows } = await c.query(
          `INSERT INTO dose_logs (user_id, medication_id, scheduled_for, status, taken_at, note)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [
            userId,
            medicationId,
            scheduledFor ? new Date(scheduledFor) : new Date(),
            s,
            s === 'taken' ? new Date(takenAt || Date.now()) : null,
            note || '',
          ],
        );
        return mapDose(rows[0]);
      });
    },
    listDoseLogs() {
      return tx(async (c) => {
        const { rows } = await c.query(
          'SELECT * FROM dose_logs WHERE user_id = $1 ORDER BY scheduled_for DESC',
          [userId],
        );
        return rows.map(mapDose);
      });
    },

    // --- Labs ---
    listLabs({ analyte, source } = {}) {
      return tx(async (c) => {
        const { rows } = await c.query(
          `SELECT * FROM lab_results
           WHERE user_id = $1
             AND ($2::text IS NULL OR analyte = $2)
             AND ($3::text IS NULL OR source = $3)
           ORDER BY collected_at ASC NULLS LAST, id`,
          [userId, analyte || null, source || null],
        );
        return rows.map(mapLab);
      });
    },
    listAnalytes() {
      return tx(async (c) => {
        const { rows } = await c.query(
          'SELECT DISTINCT analyte FROM lab_results WHERE user_id = $1 ORDER BY analyte',
          [userId],
        );
        return rows.map((r) => r.analyte);
      });
    },
    upsertLabResults(results = []) {
      return tx(async (c) => {
        for (const r of results) {
          await c.query(
            `INSERT INTO lab_results (user_id, analyte, loinc, value, unit, ref_low,
               ref_high, flag, collected_at, reported_at, source, provenance, external_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT (user_id, external_id) WHERE external_id IS NOT NULL
             DO UPDATE SET analyte = EXCLUDED.analyte, loinc = EXCLUDED.loinc,
               value = EXCLUDED.value, unit = EXCLUDED.unit, ref_low = EXCLUDED.ref_low,
               ref_high = EXCLUDED.ref_high, flag = EXCLUDED.flag,
               collected_at = EXCLUDED.collected_at, reported_at = EXCLUDED.reported_at,
               source = EXCLUDED.source, provenance = EXCLUDED.provenance,
               updated_at = now()`,
            [
              userId,
              r.analyte,
              r.loinc ?? null,
              r.value,
              r.unit || '',
              r.refLow ?? null,
              r.refHigh ?? null,
              r.flag ?? null,
              r.collectedAt ?? null,
              r.reportedAt ?? null,
              r.source,
              r.provenance ? json(r.provenance) : null,
              r.provenance?.externalId ?? null,
            ],
          );
        }
        return results.length;
      });
    },

    // --- Pallor ---
    listPallor() {
      return tx(async (c) => {
        const { rows } = await c.query(
          'SELECT * FROM pallor_photos WHERE user_id = $1 ORDER BY captured_at DESC',
          [userId],
        );
        return rows.map(mapPallor);
      });
    },
    addPallorPhoto(entry) {
      return tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO pallor_photos (user_id, captured_at, eye, pallor_score, storage, note)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [
            userId,
            entry.capturedAt ? new Date(entry.capturedAt) : new Date(),
            entry.eye || 'right',
            entry.pallorScore ?? null,
            entry.storage ? json(entry.storage) : null,
            entry.note || '',
          ],
        );
        return mapPallor(rows[0]);
      });
    },
    getPallorPhoto(id) {
      return tx(async (c) => {
        const { rows } = await c.query(
          'SELECT * FROM pallor_photos WHERE user_id = $1 AND id = $2',
          [userId, id],
        );
        return rows[0] ? mapPallor(rows[0]) : null;
      });
    },

    // --- Integrations ---
    integrationsStatus() {
      return tx(async (c) => {
        const { rows } = await c.query(
          'SELECT * FROM integration_connections WHERE user_id = $1 ORDER BY created_at',
          [userId],
        );
        return rows.map((r) => ({
          source: r.source,
          system: r.system,
          status: r.status,
          lastSyncAt: r.last_sync_at,
        }));
      });
    },
    touchIntegrationSync(source) {
      return tx(async (c) => {
        const { rows } = await c.query(
          `UPDATE integration_connections
           SET last_sync_at = now(), status = 'connected', updated_at = now()
           WHERE user_id = $1 AND source = $2
           RETURNING source, status, last_sync_at`,
          [userId, source],
        );
        if (!rows[0]) return null;
        return {
          source: rows[0].source,
          status: rows[0].status,
          lastSyncAt: rows[0].last_sync_at,
        };
      });
    },
    getConnection(source) {
      return tx(async (c) => {
        const { rows } = await c.query(
          'SELECT * FROM integration_connections WHERE user_id = $1 AND source = $2',
          [userId, source],
        );
        return rows[0] ? mapConnection(rows[0]) : null;
      });
    },
    updateConnection(source, patch) {
      return tx(async (c) => {
        await c.query(
          `INSERT INTO integration_connections (user_id, source) VALUES ($1, $2)
           ON CONFLICT (user_id, source) DO NOTHING`,
          [userId, source],
        );
        const sets = [];
        const params = [userId, source];
        for (const [key, value] of Object.entries(patch)) {
          const col = CONNECTION_COLUMNS[key];
          if (!col) continue; // unknown fields are ignored, never interpolated
          params.push(col.json && value != null ? json(value) : value);
          sets.push(`${col.name} = $${params.length}`);
        }
        const { rows } = await c.query(
          `UPDATE integration_connections SET ${[...sets, 'updated_at = now()'].join(', ')}
           WHERE user_id = $1 AND source = $2 RETURNING *`,
          params,
        );
        return mapConnection(rows[0]);
      });
    },

    // --- Account: export & erasure ---
    async exportData() {
      const [symptoms, medications, doseLogs, labResults, pallor, conns] =
        await Promise.all([
          this.listSymptoms(),
          tx(async (c) =>
            (
              await c.query(
                'SELECT * FROM medications WHERE user_id = $1 ORDER BY created_at',
                [userId],
              )
            ).rows.map(mapMedication),
          ),
          this.listDoseLogs(),
          this.listLabs(),
          this.listPallor(),
          tx(
            async (c) =>
              (
                await c.query(
                  'SELECT * FROM integration_connections WHERE user_id = $1',
                  [userId],
                )
              ).rows,
          ),
        ]);
      return {
        symptoms,
        medications,
        doseLogs,
        labResults,
        pallor,
        integrations: conns.map((r) => ({
          source: r.source,
          system: r.system,
          status: r.status,
          scopes: r.scopes,
          fhirBaseUrl: r.fhir_base_url,
          lastSyncAt: r.last_sync_at,
        })),
      };
    },
    /** Erase all of this patient's PHI in one transaction; passkeys are kept. */
    deleteAllData() {
      return tx(async (c) => {
        const del = async (table) =>
          (await c.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId])).rowCount;
        const doseLogs = await del('dose_logs');
        return {
          symptoms: await del('symptom_entries'),
          medications: await del('medications'),
          doseLogs,
          labResults: await del('lab_results'),
          pallor: await del('pallor_photos'),
          integrations: await del('integration_connections'),
        };
      });
    },

    computeFlag,
  };
}

// Patchable connection fields → columns. Anything else is ignored.
const CONNECTION_COLUMNS = {
  system: { name: 'system' },
  fhirBaseUrl: { name: 'fhir_base_url' },
  status: { name: 'status' },
  patient: { name: 'patient' },
  scopes: { name: 'scopes', json: true },
  tokens: { name: 'tokens', json: true },
  pendingAuth: { name: 'pending_auth', json: true },
  lastSyncAt: { name: 'last_sync_at' },
  lastSyncError: { name: 'last_sync_error' },
};

/** Apply SQL migrations in order, once each, under an advisory lock. */
export async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const applied = new Set(
      (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

// ------------------------------------------------------------------ mapping

const json = (v) => JSON.stringify(v);
const num = (v) => (v == null ? null : Number(v));

function mapUser(r) {
  return r && { _id: r.id, displayName: r.display_name, createdAt: r.created_at };
}
function mapPasswordLogin(r) {
  return r && { userId: r.user_id, email: r.email, passwordHash: r.password_hash };
}
function mapCredential(r) {
  return (
    r && {
      id: r.id,
      userId: r.user_id,
      publicKey: r.public_key,
      counter: Number(r.counter),
      transports: r.transports || [],
    }
  );
}
function mapSymptom(r) {
  return {
    _id: r.id,
    date: r.date,
    items: r.items || {},
    total: r.total,
    weightKg: num(r.weight_kg),
    note: r.note,
  };
}
function mapMedication(r) {
  const m = {
    _id: r.id,
    name: r.name,
    brand: r.brand,
    dose: r.dose,
    purpose: r.purpose,
    schedule: r.schedule || {},
    active: r.active,
  };
  if (r.form != null) m.form = r.form;
  if (r.rxnorm != null) m.rxnorm = r.rxnorm;
  if (r.prescriber != null) m.prescriber = r.prescriber;
  if (r.source != null) m.source = r.source;
  if (r.provenance != null) m.provenance = r.provenance;
  if (r.started_at != null) m.startedAt = r.started_at;
  if (r.stopped_at != null) m.stoppedAt = r.stopped_at;
  m.trial = r.trial ?? null;
  return m;
}
function mapDose(r) {
  return {
    _id: r.id,
    medicationId: r.medication_id,
    status: r.status,
    scheduledFor: r.scheduled_for,
    takenAt: r.taken_at,
    note: r.note,
  };
}
function mapLab(r) {
  return {
    _id: r.id,
    analyte: r.analyte,
    loinc: r.loinc,
    value: r.value,
    unit: r.unit,
    refLow: r.ref_low,
    refHigh: r.ref_high,
    flag: r.flag,
    collectedAt: r.collected_at,
    reportedAt: r.reported_at,
    source: r.source,
    provenance: r.provenance,
  };
}
function mapPallor(r) {
  return {
    _id: r.id,
    capturedAt: r.captured_at,
    eye: r.eye,
    pallorScore: r.pallor_score,
    note: r.note,
    storage: r.storage,
  };
}
function mapConnection(r) {
  return {
    source: r.source,
    system: r.system,
    fhirBaseUrl: r.fhir_base_url,
    status: r.status,
    patient: r.patient,
    scopes: r.scopes,
    tokens: r.tokens,
    pendingAuth: r.pending_auth,
    lastSyncAt: r.last_sync_at,
    lastSyncError: r.last_sync_error,
  };
}
