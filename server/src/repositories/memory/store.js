import { randomUUID } from 'node:crypto';
import { buildSeed, computeFlag } from '../../data/seed.js';

/** Ceremony challenges expire after this long (WebAuthn ceremonies are short). */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * In-memory repository. The default backend, so the app runs with zero
 * external dependencies. Every durable backend implements the same interface
 * (see repositories/index.js and docs/database-schema.md).
 *
 * Multi-patient: PHI lives in one isolated bucket per user, and is reachable
 * only through `forUser(userId)`, which returns a repository scoped to that
 * patient. There is no method that reads PHI across patients. Account-level
 * state (users, passkey credentials, ceremony challenges, the audit log) sits
 * on the top-level object.
 *
 * The seed (sample data only, no real PHI) belongs to the dev user `user_1`,
 * which is the subject used when AUTH_REQUIRED=false.
 */
export function createMemoryRepository({ seed = true } = {}) {
  const users = new Map();
  const patients = new Map(); // userId -> PHI bucket
  const credentials = []; // { id, userId, publicKey, counter, transports }
  const passwordLogins = new Map(); // userId -> { userId, email, passwordHash }
  const challenges = new Map(); // challenge -> { purpose, userId, expiresAt }
  const auditLog = [];

  const emptyBucket = () => ({
    symptomEntries: [],
    medications: [],
    doseLogs: [],
    labResults: [],
    pallorPhotos: [],
    integrationConnections: [],
    visitReports: [],
  });

  if (seed) {
    // eslint-disable-next-line no-unused-vars -- the seed's audit log is dropped
    const { user, auditLog, ...phi } = buildSeed();
    users.set(user._id, { ...user, createdAt: new Date() });
    patients.set(user._id, { ...emptyBucket(), ...phi });
  }

  const bucketFor = (userId) => {
    if (!userId) throw new Error('repository: a userId is required for PHI access');
    let bucket = patients.get(userId);
    if (!bucket) {
      bucket = emptyBucket();
      patients.set(userId, bucket);
    }
    return bucket;
  };

  return {
    kind: 'memory',

    /** A repository scoped to one patient's PHI. */
    forUser(userId) {
      return createPatientScope(userId, bucketFor(userId));
    },

    // --- Users ---
    createUser({ displayName = '' } = {}) {
      const user = { _id: `u_${randomUUID()}`, displayName, createdAt: new Date() };
      users.set(user._id, user);
      bucketFor(user._id);
      return user;
    },
    getUser(userId) {
      return users.get(userId) || null;
    },
    countUsers() {
      return users.size;
    },
    /**
     * Remove the account itself: the user, their passkeys and their PHI.
     * Audit entries are kept (append-only by design).
     */
    deleteUser(userId) {
      users.delete(userId);
      patients.delete(userId);
      passwordLogins.delete(userId);
      for (let i = credentials.length - 1; i >= 0; i--) {
        if (credentials[i].userId === userId) credentials.splice(i, 1);
      }
    },

    // --- Passkey credentials ---
    listCredentials(userId) {
      return credentials.filter((c) => c.userId === userId);
    },
    countCredentials() {
      return credentials.length;
    },
    /** Look up a credential by its id (global: this is how sign-in finds the user). */
    getCredential(id) {
      return credentials.find((c) => c.id === id) || null;
    },
    addCredential(userId, cred) {
      const record = { ...cred, userId };
      credentials.push(record);
      return record;
    },
    updateCredentialCounter(id, counter) {
      const cred = credentials.find((c) => c.id === id);
      if (cred) cred.counter = counter;
    },

    // --- Email + password logins (one per user; email unique) ---
    /** Look up a login by normalized email (global: this is how sign-in finds the user). */
    getPasswordLogin(email) {
      for (const l of passwordLogins.values()) if (l.email === email) return { ...l };
      return null;
    },
    getPasswordLoginForUser(userId) {
      const l = passwordLogins.get(userId);
      return l ? { ...l } : null;
    },
    countPasswordLogins() {
      return passwordLogins.size;
    },
    /** Create or replace a user's login. Throws EMAIL_TAKEN if another user has the email. */
    setPasswordLogin(userId, { email, passwordHash }) {
      for (const l of passwordLogins.values()) {
        if (l.email === email && l.userId !== userId) throw emailTaken();
      }
      const record = { userId, email, passwordHash };
      passwordLogins.set(userId, record);
      return { ...record };
    },

    // --- WebAuthn ceremony challenges (single use, short-lived) ---
    saveChallenge(challenge, { purpose, userId = null }) {
      challenges.set(challenge, {
        purpose,
        userId,
        expiresAt: Date.now() + CHALLENGE_TTL_MS,
      });
    },
    /** Return and delete a live challenge, or null if unknown/expired/wrong purpose. */
    consumeChallenge(challenge, purpose) {
      const record = challenges.get(challenge);
      if (!record) return null;
      challenges.delete(challenge);
      if (record.purpose !== purpose || record.expiresAt < Date.now()) return null;
      return { purpose: record.purpose, userId: record.userId };
    },

    // --- Audit (append-only) ---
    recordAudit(entry) {
      auditLog.push({ ...entry });
    },
    getAuditLog({ userId } = {}) {
      return userId ? auditLog.filter((e) => e.userId === userId) : [...auditLog];
    },

    computeFlag,
  };
}

function emailTaken() {
  const err = new Error('an account with that email already exists');
  err.code = 'EMAIL_TAKEN';
  return err;
}

/** The PHI surface for a single patient. Every method touches only `db`. */
function createPatientScope(userId, db) {
  const inRange = (date, from, to) => {
    const t = new Date(date).getTime();
    if (from && t < new Date(from).getTime()) return false;
    if (to && t > new Date(to).getTime()) return false;
    return true;
  };

  return {
    kind: 'memory',
    userId,

    // --- Symptoms ---
    listSymptoms({ from, to } = {}) {
      return db.symptomEntries
        .filter((e) => inRange(e.date, from, to))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    },
    upsertSymptomEntry(entry) {
      const date = entry.date ? new Date(entry.date) : new Date();
      const dayKey = date.toISOString().slice(0, 10);
      const existing = db.symptomEntries.find(
        (e) => new Date(e.date).toISOString().slice(0, 10) === dayKey,
      );
      const record = {
        _id: existing?._id || `s_${randomUUID()}`,
        date,
        items: entry.items || {},
        total: entry.total ?? 0,
        weightKg: entry.weightKg ?? null,
        note: entry.note || '',
      };
      if (existing) Object.assign(existing, record);
      else db.symptomEntries.push(record);
      return record;
    },

    // --- Medications & doses ---
    listMedications() {
      return db.medications.filter((m) => m.active);
    },
    /**
     * Idempotently insert/update medications from a sync. Dedup by
     * provenance.externalId (FHIR-sourced); others are appended. Returns count.
     */
    upsertMedications(meds = []) {
      for (const m of meds) {
        const externalId = m.provenance?.externalId;
        const existing = externalId
          ? db.medications.find((x) => x.provenance?.externalId === externalId)
          : null;
        const now = new Date();
        if (existing) Object.assign(existing, m, { updatedAt: now });
        else {
          db.medications.push({
            _id: m._id || `med_${randomUUID()}`,
            createdAt: now,
            updatedAt: now,
            ...m,
          });
        }
      }
      return meds.length;
    },
    /** Add one medication (patient-entered). Returns the stored record. */
    createMedication(m) {
      const now = new Date();
      const record = {
        _id: `med_${randomUUID()}`,
        active: true,
        createdAt: now,
        updatedAt: now,
        ...m,
      };
      db.medications.push(record);
      return { ...record };
    },
    /** Patch one medication (active or stopped). Returns it, or null if unknown. */
    updateMedication(id, patch) {
      const med = db.medications.find((m) => m._id === id);
      if (!med) return null;
      Object.assign(med, patch, { updatedAt: new Date() });
      return { ...med };
    },
    logDose(medicationId, { status, scheduledFor, takenAt, note } = {}) {
      const med = db.medications.find((m) => m._id === medicationId);
      if (!med) return null;
      const record = {
        _id: `dose_${randomUUID()}`,
        medicationId,
        status: status || 'taken',
        scheduledFor: scheduledFor ? new Date(scheduledFor) : new Date(),
        takenAt: status === 'taken' ? new Date(takenAt || Date.now()) : null,
        note: note || '',
      };
      db.doseLogs.push(record);
      return record;
    },
    /** Every medication, including stopped ones (for change history). */
    listAllMedications() {
      return db.medications.map((m) => ({ ...m }));
    },
    /**
     * Create or replace the record for one scheduled dose (medication +
     * scheduled time). Returns null for an unknown medication.
     */
    upsertDose(medicationId, { scheduledFor, status, takenAt, note, amount } = {}) {
      if (!db.medications.some((m) => m._id === medicationId)) return null;
      const when = new Date(scheduledFor);
      const s = status || 'taken';
      const fields = {
        status: s,
        takenAt: s === 'taken' || s === 'late' ? new Date(takenAt || Date.now()) : null,
        note: note || '',
        amount: amount ?? null,
      };
      const existing = db.doseLogs.find(
        (d) =>
          d.medicationId === medicationId &&
          new Date(d.scheduledFor).getTime() === when.getTime(),
      );
      if (existing) {
        Object.assign(existing, fields);
        return { ...existing };
      }
      const record = {
        _id: `dose_${randomUUID()}`,
        medicationId,
        scheduledFor: when,
        ...fields,
      };
      db.doseLogs.push(record);
      return { ...record };
    },
    /** Remove one scheduled dose's record. Returns whether one existed. */
    clearDose(medicationId, scheduledFor) {
      const t = new Date(scheduledFor).getTime();
      const i = db.doseLogs.findIndex(
        (d) =>
          d.medicationId === medicationId && new Date(d.scheduledFor).getTime() === t,
      );
      if (i < 0) return false;
      db.doseLogs.splice(i, 1);
      return true;
    },
    listDoseLogs({ from, to } = {}) {
      return [...db.doseLogs]
        .filter((d) => inRange(d.scheduledFor, from, to))
        .sort((a, b) => new Date(b.scheduledFor) - new Date(a.scheduledFor));
    },

    // --- Labs ---
    listLabs({ analyte, source } = {}) {
      return db.labResults
        .filter(
          (l) => (!analyte || l.analyte === analyte) && (!source || l.source === source),
        )
        .sort((a, b) => new Date(a.collectedAt) - new Date(b.collectedAt));
    },
    listAnalytes() {
      return [...new Set(db.labResults.map((l) => l.analyte))];
    },
    /**
     * Idempotently insert/update lab results. Dedup by provenance.externalId
     * (FHIR-sourced) so re-syncs don't duplicate; results without one are
     * always inserted. Returns the number processed.
     */
    upsertLabResults(results = []) {
      for (const r of results) {
        const externalId = r.provenance?.externalId;
        const existing = externalId
          ? db.labResults.find((l) => l.provenance?.externalId === externalId)
          : null;
        if (existing) Object.assign(existing, r);
        else db.labResults.push({ _id: r._id || `lab_${randomUUID()}`, ...r });
      }
      return results.length;
    },

    // --- Pallor ---
    listPallor() {
      return [...db.pallorPhotos].sort(
        (a, b) => new Date(b.capturedAt) - new Date(a.capturedAt),
      );
    },
    addPallorPhoto(entry) {
      const record = {
        _id: `p_${randomUUID()}`,
        capturedAt: entry.capturedAt ? new Date(entry.capturedAt) : new Date(),
        eye: entry.eye || 'right',
        pallorScore: entry.pallorScore ?? null,
        note: entry.note || '',
        storage: entry.storage || null,
      };
      db.pallorPhotos.unshift(record);
      return record;
    },
    getPallorPhoto(id) {
      return db.pallorPhotos.find((p) => p._id === id) || null;
    },

    // --- Integrations ---
    integrationsStatus() {
      return db.integrationConnections.map((c) => ({
        source: c.source,
        system: c.system,
        status: c.status,
        lastSyncAt: c.lastSyncAt,
      }));
    },
    touchIntegrationSync(source) {
      const conn = db.integrationConnections.find((c) => c.source === source);
      if (!conn) return null;
      conn.lastSyncAt = new Date();
      conn.status = 'connected';
      return { source: conn.source, status: conn.status, lastSyncAt: conn.lastSyncAt };
    },
    getConnection(source) {
      return db.integrationConnections.find((c) => c.source === source) || null;
    },
    updateConnection(source, patch) {
      let conn = db.integrationConnections.find((c) => c.source === source);
      if (!conn) {
        conn = { source };
        db.integrationConnections.push(conn);
      }
      Object.assign(conn, patch);
      return conn;
    },

    // --- Visit reports ---
    listReports() {
      return [...db.visitReports].sort(
        (a, b) => new Date(b.periodEnd) - new Date(a.periodEnd),
      );
    },
    createReport({ periodStart, periodEnd, recipients = [], summary = null }) {
      const record = {
        _id: `rep_${randomUUID()}`,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        sentAt: new Date(),
        recipients,
        summary,
      };
      db.visitReports.push(record);
      return { ...record };
    },

    // --- Account: export & erasure ---
    /**
     * The patient's full record as plain data, for a "download my data"
     * export. Integration connections are included as metadata only, never
     * the encrypted OAuth tokens.
     */
    exportData() {
      return {
        symptoms: db.symptomEntries,
        medications: db.medications,
        doseLogs: db.doseLogs,
        labResults: db.labResults,
        pallor: db.pallorPhotos,
        visitReports: db.visitReports,
        integrations: db.integrationConnections.map((c) => ({
          source: c.source,
          system: c.system,
          status: c.status,
          scopes: c.scopes,
          fhirBaseUrl: c.fhirBaseUrl,
          lastSyncAt: c.lastSyncAt,
        })),
      };
    },
    /**
     * Erase all of this patient's PHI and return per-collection counts. The
     * passkey credential is kept so the patient can sign back in.
     */
    deleteAllData() {
      const counts = {
        symptoms: db.symptomEntries.length,
        medications: db.medications.length,
        doseLogs: db.doseLogs.length,
        labResults: db.labResults.length,
        pallor: db.pallorPhotos.length,
        integrations: db.integrationConnections.length,
        visitReports: db.visitReports.length,
      };
      for (const key of Object.keys(db)) db[key].length = 0;
      return counts;
    },

    computeFlag,
  };
}
