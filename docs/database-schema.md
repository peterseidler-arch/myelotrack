# MyeloTrack — Database Schema (PostgreSQL)

The production store is **Cloud SQL for PostgreSQL**, covered by Google Cloud's
HIPAA business associate agreement. The schema is defined in
[`server/src/repositories/postgres/migrations/`](../server/src/repositories/postgres/migrations/),
which the server applies on start (in order, once each, under an advisory
lock). This document explains it; the SQL is the source of truth.

The in-memory backend (`DATA_BACKEND=memory`, the local-dev default) implements
the same repository interface with the same field names, seeded with sample
data only. Both backends pass the same contract tests
(`server/test/repository-contract.js`).

## Multi-patient isolation

MyeloTrack serves many patients from one database. Isolation is enforced in
three layers:

1. **The repository interface.** PHI is reachable only through
   `repo.forUser(userId)`, which returns methods scoped to one patient. No
   method reads PHI across patients. `requireAuth` binds `req.repo` to the
   signed-in user, so controllers can't pick a different one.
2. **Explicit filters.** Every query on a PHI table includes `user_id = $1`.
3. **Row-level security in the database.** Every PHI table has
   `FORCE ROW LEVEL SECURITY` with a `patient_isolation` policy:
   `user_id = current_setting('app.user_id', true)`. Each patient-scoped call
   runs in its own transaction that first sets `app.user_id` (transaction-local).
   A query that forgot its `WHERE` clause still sees only that patient's rows,
   and with no patient bound it sees nothing.

RLS is bypassed by superusers and roles with `BYPASSRLS`. The server checks its
role on start and **refuses to start in production** if it could bypass RLS.
Use a dedicated app role (`scripts/setup-gcp.sh` creates `myelotrack_app`).

## Conventions

- Ids are `text`. Users are `u_<uuid>`; other rows default to a UUID string.
  The API exposes them as `_id`.
- Timestamps are `timestamptz` (UTC). Every table has `created_at`; mutable
  tables also have `updated_at`.
- Nested, schema-light fields (symptom items, provenance, storage metadata,
  schedules, encrypted tokens) are `jsonb`.
- Numeric lab values keep their `unit` and reference range.
- Foreign keys from PHI tables to `users` are `ON DELETE CASCADE`, so deleting
  a user removes all their data in one statement.

---

## Account tables (no PHI)

### `users`

| column         | type        | notes                      |
| -------------- | ----------- | -------------------------- |
| `id`           | text PK     | `u_<uuid>`; never an email |
| `display_name` | text        | optional                   |
| `created_at`   | timestamptz |                            |
| `updated_at`   | timestamptz |                            |

Deliberately minimal: an account is a random id plus its passkeys. Clinical
profile fields belong in a future PHI table, not here.

### `passkey_credentials`

One row per registered WebAuthn passkey. Sign-in uses discoverable
credentials, so the server learns _who_ is signing in from the credential id.

| column       | type    | notes                        |
| ------------ | ------- | ---------------------------- |
| `id`         | text PK | credential id (base64url)    |
| `user_id`    | text FK | → `users.id`, cascade        |
| `public_key` | text    | COSE public key (base64url)  |
| `counter`    | bigint  | signature counter            |
| `transports` | jsonb   | e.g. `["internal","hybrid"]` |

### `auth_challenges`

Single-use WebAuthn ceremony challenges, valid for 5 minutes. A registration
challenge carries `user_id` when a signed-in user is adding another passkey;
otherwise verifying it creates a new account.

| column       | type        | notes                                   |
| ------------ | ----------- | --------------------------------------- |
| `challenge`  | text PK     |                                         |
| `purpose`    | text        | `registration` \| `authentication`      |
| `user_id`    | text FK     | nullable                                |
| `expires_at` | timestamptz | expired rows are swept on each new save |

---

## PHI tables (row-level security on all of them)

### `symptom_entries`

One row per patient per UTC day: the MPN-SAF TSS check-in. Ten items, each
0–10; `total` (0–100) is denormalized on write for cheap trending. A second
check-in on the same day replaces the first (`UNIQUE (user_id, day)`).

| column      | type        | notes                                |
| ----------- | ----------- | ------------------------------------ |
| `day`       | date        | UTC calendar day                     |
| `date`      | timestamptz | when it was recorded                 |
| `items`     | jsonb       | `{ fatigue: 6, earlySatiety: 4, … }` |
| `total`     | integer     | 0–100                                |
| `weight_kg` | numeric     | optional                             |
| `note`      | text        |                                      |

### `medications`

The regimen. Rows from a FHIR sync carry `provenance` and an `external_id`
(`provenance.externalId`), which is the dedup key for re-syncs:
`UNIQUE (user_id, external_id) WHERE external_id IS NOT NULL`.

Columns: `name`, `brand`, `dose`, `form`, `purpose`, `rxnorm`,
`schedule` (jsonb, e.g. `{ "times": ["08:00","20:00"] }`), `prescriber`
(jsonb), `active`, `source`, `provenance` (jsonb), `external_id`,
`started_at`, `stopped_at`. Index `(user_id, active)`.

### `dose_logs`

One row per dose event. Adherence % is computed over a window:
taken / (taken + skipped + missed).

Columns: `medication_id` (FK, cascade), `scheduled_for`, `status`
(`taken` \| `skipped` \| `missed` \| `late`), `taken_at`, `note`.
Indexes `(user_id, scheduled_for DESC)` and
`(user_id, medication_id, scheduled_for DESC)`.

### `lab_results`

The core of the app: CBC-centric results **aggregated across care teams**,
one row per analyte per draw. `source` + `provenance` always say which
institution a value came from.

Columns: `analyte` (canonical key: `hemoglobin`, `hematocrit`, `platelets`,
`wbc`, `anc`, `blasts`, …), `loinc`, `value`, `unit`, `ref_low`, `ref_high`,
`flag` (`low` \| `high` \| `critical` \| `normal`), `collected_at`,
`reported_at`, `source` (`msk` \| `capital-health` \| `apple-health` \|
`manual`), `provenance` (jsonb: `system`, `resourceType`, `externalId`, …),
`external_id`.

Indexes:

- `(user_id, analyte, collected_at DESC)` for trends.
- `(user_id, source, collected_at DESC)` for per-source filters.
- `UNIQUE (user_id, external_id) WHERE external_id IS NOT NULL` for
  idempotent sync. The same upstream id for two patients is two rows.

> **Cross-team dedup note:** the same physical draw is not expected from two
> institutions. If a value is entered `manual` and later arrives via FHIR,
> reconciliation should prefer the FHIR record and mark the manual one
> superseded rather than delete it (not yet implemented).

### `pallor_photos`

Eye-photo (palpebral conjunctiva) readings, a rough at-home anemia proxy. The
**image bytes never go in the database**: they are AES-256-GCM encrypted and
written to Cloud Storage under `u/<userId>/…`; the row holds the key and digest.

Columns: `captured_at`, `eye` (`left` \| `right`), `pallor_score` (0–1,
heuristic, never diagnostic), `storage` (jsonb: `bucket`, `key`, `sha256`,
`contentType`, `bytes`), `linked_hemoglobin_id`, `note`.

### `integration_connections`

Per-patient, per-source SMART-on-FHIR connection state. Primary key
`(user_id, source)`. OAuth tokens are **field-level encrypted** before they
reach the database and are never returned to the client.

Columns: `system`, `fhir_base_url`, `status` (`connected` \| `expired` \|
`error` \| `disconnected`), `patient` (upstream FHIR Patient id), `scopes`
(jsonb), `tokens` (jsonb, encrypted values), `pending_auth` (jsonb: PKCE
verifier + state while connecting), `last_sync_at`, `last_sync_error`.

---

## `audit_log` (append-only)

One row per request to the PHI API: who, what, when, from where. A trigger
rejects every `UPDATE`, `DELETE` and `TRUNCATE`, so entries can't be changed
in place, even by the app's own role. `user_id` has no foreign key on purpose:
the trail outlives a deleted account.

| column       | type        | notes                                      |
| ------------ | ----------- | ------------------------------------------ |
| `id`         | bigserial   |                                            |
| `user_id`    | text        | null for public auth routes                |
| `actor`      | text        | `user` \| `integration-worker` \| `system` |
| `action`     | text        | `read` \| `create` \| `update` \| `delete` |
| `route`      | text        | e.g. `GET /api/v1/labs`                    |
| `status`     | integer     | HTTP status                                |
| `ip`         | text        |                                            |
| `user_agent` | text        |                                            |
| `meta`       | jsonb       | anything else                              |
| `at`         | timestamptz |                                            |

Retention and export to long-term storage are a later ops task.

---

## Relationships at a glance

```
users ─┬─< passkey_credentials
       ├─< auth_challenges
       ├─< symptom_entries
       ├─< medications ─< dose_logs
       ├─< lab_results  >── (linked_hemoglobin_id) ──< pallor_photos
       ├─< integration_connections   (source ⇄ lab_results.source)
       └ ─ audit_log (user_id, no FK)
```
