-- MyeloTrack schema v1 (PostgreSQL 15+; Cloud SQL for PostgreSQL).
--
-- Isolation model:
--   * Account tables (users, passkey_credentials, auth_challenges) are reached
--     only through account-level repository methods.
--   * Every PHI table carries user_id and has FORCED row-level security: a row
--     is visible or writable only when user_id matches the transaction-local
--     setting app.user_id. The repository sets it with set_config(..., true)
--     inside each patient-scoped transaction, so a query that forgets its
--     WHERE user_id clause still cannot cross patients.
--   * The runtime role must NOT be a superuser or have BYPASSRLS.
--   * audit_log is append-only: a trigger rejects UPDATE and DELETE.

CREATE TABLE users (
  id            text PRIMARY KEY,
  display_name  text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passkey_credentials (
  id          text PRIMARY KEY,                -- WebAuthn credential id (base64url)
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key  text NOT NULL,                   -- base64url COSE key
  counter     bigint NOT NULL DEFAULT 0,
  transports  jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passkey_credentials_user_idx ON passkey_credentials (user_id);

CREATE TABLE auth_challenges (
  challenge   text PRIMARY KEY,
  purpose     text NOT NULL CHECK (purpose IN ('registration', 'authentication')),
  user_id     text REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX auth_challenges_expiry_idx ON auth_challenges (expires_at);

-- ---------------------------------------------------------------- PHI tables

CREATE TABLE symptom_entries (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day         date NOT NULL,                   -- UTC calendar day (one entry per day)
  date        timestamptz NOT NULL,
  items       jsonb NOT NULL DEFAULT '{}',     -- MPN-SAF items, each 0-10
  total       integer NOT NULL DEFAULT 0,      -- 0-100
  weight_kg   numeric,
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, day)
);

CREATE TABLE medications (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  brand        text NOT NULL DEFAULT '',
  dose         text NOT NULL DEFAULT '',
  form         text,
  purpose      text NOT NULL DEFAULT '',
  rxnorm       text,
  schedule     jsonb NOT NULL DEFAULT '{}',
  prescriber   jsonb,
  active       boolean NOT NULL DEFAULT true,
  source       text,
  provenance   jsonb,
  external_id  text,                           -- provenance.externalId (sync dedup key)
  started_at   timestamptz,
  stopped_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX medications_user_active_idx ON medications (user_id, active);
CREATE UNIQUE INDEX medications_user_external_uidx
  ON medications (user_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE dose_logs (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medication_id  text NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  scheduled_for  timestamptz NOT NULL,
  status         text NOT NULL CHECK (status IN ('taken', 'skipped', 'missed', 'late')),
  taken_at       timestamptz,
  note           text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dose_logs_user_sched_idx ON dose_logs (user_id, scheduled_for DESC);
CREATE INDEX dose_logs_user_med_idx ON dose_logs (user_id, medication_id, scheduled_for DESC);

CREATE TABLE lab_results (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  analyte       text NOT NULL,
  loinc         text,
  value         double precision NOT NULL,
  unit          text NOT NULL DEFAULT '',
  ref_low       double precision,
  ref_high      double precision,
  flag          text,
  collected_at  timestamptz,
  reported_at   timestamptz,
  source        text NOT NULL,
  provenance    jsonb,
  external_id   text,                          -- provenance.externalId (sync dedup key)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lab_results_trend_idx ON lab_results (user_id, analyte, collected_at DESC);
CREATE INDEX lab_results_source_idx ON lab_results (user_id, source, collected_at DESC);
CREATE UNIQUE INDEX lab_results_user_external_uidx
  ON lab_results (user_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE pallor_photos (
  id                     text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  captured_at            timestamptz NOT NULL,
  eye                    text NOT NULL DEFAULT 'right' CHECK (eye IN ('left', 'right')),
  pallor_score           double precision CHECK (pallor_score BETWEEN 0 AND 1),
  storage                jsonb,               -- object-store key + digest, never bytes
  linked_hemoglobin_id   text,
  note                   text NOT NULL DEFAULT '',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pallor_photos_user_idx ON pallor_photos (user_id, captured_at DESC);

CREATE TABLE integration_connections (
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source           text NOT NULL,
  system           text,
  fhir_base_url    text,
  status           text NOT NULL DEFAULT 'disconnected',
  patient          text,                       -- upstream FHIR Patient id
  scopes           jsonb,
  tokens           jsonb,                      -- field-level encrypted (AES-256-GCM)
  pending_auth     jsonb,                      -- PKCE verifier + state during connect
  last_sync_at     timestamptz,
  last_sync_error  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source)
);

-- Row-level security on every PHI table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'symptom_entries', 'medications', 'dose_logs', 'lab_results',
    'pallor_photos', 'integration_connections'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY patient_isolation ON %I
         USING (user_id = current_setting(''app.user_id'', true))
         WITH CHECK (user_id = current_setting(''app.user_id'', true))', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ audit log

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  user_id     text,                            -- no FK: entries outlive the account
  actor       text NOT NULL,
  action      text NOT NULL,
  route       text,
  status      integer,
  ip          text,
  user_agent  text,
  meta        jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, at DESC);

CREATE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
