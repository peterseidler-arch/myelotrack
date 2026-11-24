// Postgres repository tests. They need a real database and self-skip when
// DATABASE_TEST_URL is unset (e.g. a plain local `npm test`). CI provides one.
//
// Connect as a NON-superuser role: superusers bypass row-level security, and
// the isolation tests below would then fail (correctly).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runRepositoryContract } from './repository-contract.js';

const url = process.env.DATABASE_TEST_URL;

if (!url) {
  test(
    'postgres repository (skipped: DATABASE_TEST_URL not set)',
    { skip: true },
    () => {},
  );
} else {
  const pg = (await import('pg')).default;
  const { createPostgresRepository } =
    await import('../src/repositories/postgres/store.js');

  // Each test gets its own schema so runs never interfere and start empty.
  const schemas = [];
  const pools = [];
  async function freshRepo() {
    const schema = `t_${randomUUID().replace(/-/g, '')}`;
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    const pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    schemas.push(schema);
    pools.push(pool);
    return createPostgresRepository({ pool });
  }

  after(async () => {
    for (const p of pools) await p.end();
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    for (const s of schemas) await admin.query(`DROP SCHEMA ${s} CASCADE`);
    await admin.end();
  });

  runRepositoryContract('postgres', freshRepo);

  test('[postgres] the app role is subject to row-level security', async () => {
    const repo = await freshRepo();
    const { rows } = await repo.pool.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    assert.equal(rows[0].rolsuper, false, 'tests must not run as a superuser');
    assert.equal(rows[0].rolbypassrls, false);
  });

  test('[postgres] RLS blocks cross-patient reads even without a WHERE clause', async () => {
    const repo = await freshRepo();
    const a = (await repo.createUser())._id;
    const b = (await repo.createUser())._id;
    await repo.forUser(a).upsertSymptomEntry({ items: {}, total: 1, note: 'secret' });

    const client = await repo.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [b]);
      const asB = await client.query('SELECT * FROM symptom_entries');
      assert.equal(asB.rowCount, 0);
      await assert.rejects(
        client.query(
          `INSERT INTO symptom_entries (user_id, day, date) VALUES ($1, current_date, now())`,
          [a],
        ),
        /row-level security/,
      );
      await client.query('ROLLBACK');

      // No patient bound at all: nothing is visible.
      const unbound = await client.query('SELECT * FROM symptom_entries');
      assert.equal(unbound.rowCount, 0);
    } finally {
      client.release();
    }
  });

  test('[postgres] the audit log rejects updates and deletes', async () => {
    const repo = await freshRepo();
    await repo.recordAudit({
      userId: 'u',
      actor: 'user',
      action: 'read',
      at: new Date(),
    });
    await assert.rejects(
      repo.pool.query("UPDATE audit_log SET action = 'x'"),
      /append-only/,
    );
    await assert.rejects(repo.pool.query('DELETE FROM audit_log'), /append-only/);
    assert.equal((await repo.getAuditLog()).length, 1);
  });

  test('[postgres] migrations are idempotent', async () => {
    const repo = await freshRepo();
    const { runMigrations } = await import('../src/repositories/postgres/store.js');
    await runMigrations(repo.pool);
    const { rows } = await repo.pool.query(
      'SELECT count(*)::int AS n FROM schema_migrations',
    );
    // Each migration file is recorded exactly once, however often they run.
    const { readdir } = await import('node:fs/promises');
    const files = (
      await readdir(new URL('../src/repositories/postgres/migrations/', import.meta.url))
    ).filter((f) => f.endsWith('.sql'));
    assert.equal(rows[0].n, files.length);
  });
}
