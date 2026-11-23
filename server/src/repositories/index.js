import { config } from '../config/index.js';
import { createMemoryRepository } from './memory/store.js';
import { DEV_USER_ID } from '../middleware/auth.js';

/**
 * Resolve the data repository for the configured backend.
 *
 * - "memory" (default): seeded in-memory store, zero external dependencies.
 *   Sample data only; never used in production (see assertSafeToServe).
 * - "postgres": PostgreSQL (Cloud SQL in production) with row-level security
 *   per patient. Lazily imported so the memory path never loads `pg`.
 *
 * Both implement the same interface: account-level methods on the returned
 * object, and all PHI behind `forUser(userId)`.
 *
 * @returns {Promise<object>}
 */
export async function createRepository() {
  if (config.dataBackend === 'postgres') {
    if (!config.databaseUrl) throw new Error('DATA_BACKEND=postgres needs DATABASE_URL');
    const { createPostgresRepository } = await import('./postgres/store.js');
    const repo = await createPostgresRepository({ connectionString: config.databaseUrl });
    if (await repo.bypassesRowSecurity()) {
      const msg =
        'the database role bypasses row-level security; connect as a role without ' +
        'SUPERUSER or BYPASSRLS so the database itself isolates patients';
      if (config.isProduction) throw new Error(`refusing to start: ${msg}`);
      console.warn(`[db] warning: ${msg}`);
    }
    // Local dev with sign-in off acts as one fixed user; make sure it exists.
    if (!config.auth.required) await repo.ensureUser(DEV_USER_ID);
    return repo;
  }
  if (config.dataBackend !== 'memory') {
    throw new Error(
      `unknown DATA_BACKEND: ${config.dataBackend} (use memory or postgres)`,
    );
  }
  return createMemoryRepository();
}
