-- Dose diary: one record per medication per scheduled dose, with the amount
-- taken (tablets and mg), so a trial diary can be filled and corrected.
ALTER TABLE dose_logs ADD COLUMN amount jsonb;

-- Keep only the newest record for each (patient, medication, scheduled time)
-- before making that combination unique. This cleanup must see every
-- patient's rows, so row-level security is relaxed for the table owner for
-- this one statement and forced again right after (all inside the migration's
-- transaction, so it is never observable).
ALTER TABLE dose_logs NO FORCE ROW LEVEL SECURITY;
DELETE FROM dose_logs d
USING dose_logs newer
WHERE d.user_id = newer.user_id
  AND d.medication_id = newer.medication_id
  AND d.scheduled_for = newer.scheduled_for
  AND (newer.updated_at, newer.created_at, newer.id) > (d.updated_at, d.created_at, d.id);
ALTER TABLE dose_logs FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX dose_logs_slot_uidx
  ON dose_logs (user_id, medication_id, scheduled_for);

-- Visit reports the patient approved and sent to their care team. The next
-- report covers everything since the last one's period_end.
CREATE TABLE visit_reports (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  recipients    jsonb NOT NULL DEFAULT '[]',
  summary       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visit_reports_user_idx ON visit_reports (user_id, period_end DESC);

ALTER TABLE visit_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_isolation ON visit_reports
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
