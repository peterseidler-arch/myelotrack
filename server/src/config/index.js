/** Runtime configuration, resolved from the environment with safe defaults. */

/**
 * Per-source SMART on FHIR settings, read from env. Both MSK and Capital Health
 * run Epic, so this is the same shape pointed at different base URLs / clients.
 * Empty when unconfigured — the connect flow reports "not configured" rather
 * than throwing.
 */
function fhirSource(prefix) {
  return {
    fhirBaseUrl: process.env[`${prefix}_FHIR_BASE_URL`] || '',
    authorizeUrl: process.env[`${prefix}_AUTHORIZE_URL`] || '',
    tokenUrl: process.env[`${prefix}_TOKEN_URL`] || '',
    clientId: process.env[`${prefix}_CLIENT_ID`] || '',
    redirectUri: process.env[`${prefix}_REDIRECT_URI`] || '',
    scopes: (
      process.env[`${prefix}_SCOPES`] ||
      'openid fhirUser patient/Observation.read patient/MedicationRequest.read'
    )
      .split(/\s+/)
      .filter(Boolean),
  };
}

export const config = {
  port: Number(process.env.PORT) || 8787,
  // Absolute path to the built web client (web/dist). When set, the API also
  // serves the PWA from the same origin — the single-service production
  // topology (see Dockerfile). Unset in dev/tests, where the web dev server
  // hosts the client separately.
  webDir: process.env.WEB_DIR || '',
  dataBackend: process.env.DATA_BACKEND || 'memory',
  // Postgres connection string (DATA_BACKEND=postgres). On Cloud Run with the
  // Cloud SQL connector: postgresql://USER:PASS@/DB?host=/cloudsql/PROJECT:REGION:INSTANCE
  databaseUrl: process.env.DATABASE_URL || '',
  isProduction: process.env.NODE_ENV === 'production',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Where to send the browser after a successful OAuth callback. When unset,
  // the callback returns JSON instead of redirecting (used by tests).
  appUrl: process.env.APP_URL || '',
  // 32-byte base64 key for encrypting OAuth tokens + pallor images at rest.
  // Required before any real integration connects or image upload; unset in the
  // default seeded/dev setup.
  fieldEncryptionKey: process.env.FIELD_ENCRYPTION_KEY || '',
  // Object storage for pallor images. "local" writes encrypted blobs under
  // storageDir; "memory" keeps them in-process (tests); "gcs" is the production
  // target (Google Cloud Storage bucket). All backends encrypt bytes at rest.
  storageBackend: process.env.STORAGE_BACKEND || 'local',
  storageDir: process.env.STORAGE_DIR || './.data/pallor',
  storageBucket: process.env.STORAGE_BUCKET || 'myelotrack-pallor',
  fhirSources: {
    msk: fhirSource('MSK'),
    'capital-health': fhirSource('CAPITAL_HEALTH'),
  },
  // Passkey (WebAuthn) auth. Off by default so local dev on sample data keeps
  // working. Production refuses to start without it (see assertSafeToServe).
  auth: {
    required: process.env.AUTH_REQUIRED === 'true',
    rpId: process.env.RP_ID || 'localhost',
    rpName: process.env.RP_NAME || 'MyeloTrack',
    // Expected origin(s) of the web app, for WebAuthn verification.
    origin: (process.env.RP_ORIGIN || 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // HMAC secret for session tokens. Defaults to the field key if unset.
    sessionSecret: process.env.SESSION_SECRET || process.env.FIELD_ENCRYPTION_KEY || '',
  },
};

/** True when a source has enough config to attempt the OAuth flow. */
export const isSourceConfigured = (source) => {
  const c = config.fhirSources[source];
  return Boolean(c && c.authorizeUrl && c.tokenUrl && c.clientId && c.redirectUri);
};

/**
 * Refuse to start in a configuration that could expose or lose real health
 * data. In production: sign-in must be on, data must live in Postgres (not the
 * in-memory sample store), and the session/encryption secrets must be set.
 * Throws with every problem listed; a no-op outside production.
 */
export function assertSafeToServe(c = config) {
  if (!c.isProduction) return;
  const problems = [];
  if (!c.auth.required) problems.push('AUTH_REQUIRED must be true');
  if (c.dataBackend !== 'postgres') problems.push('DATA_BACKEND must be postgres');
  if (c.dataBackend === 'postgres' && !c.databaseUrl)
    problems.push('DATABASE_URL is not set');
  if (!c.fieldEncryptionKey) problems.push('FIELD_ENCRYPTION_KEY is not set');
  if (!process.env.SESSION_SECRET) problems.push('SESSION_SECRET is not set');
  if (problems.length) {
    throw new Error(`refusing to start in production: ${problems.join('; ')}`);
  }
}
