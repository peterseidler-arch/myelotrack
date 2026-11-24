# MyeloTrack — Architecture

MyeloTrack is a health-tracking app for people managing a myeloproliferative
neoplasm (MPN). It started as one patient's tool (myelofibrosis with an MDS
overlap) and is now **multi-patient**: anyone can create an account, and each
patient sees only their own record.
The clinical reality that drives the architecture: **care is split across
multiple institutions**, each with its own patient portal and its own copy of
the labs. Bloodwork gets drawn at Memorial Sloan Kettering (MSK) for the
MPN/transplant workstream and at Capital Health for local/routine draws, and
neither portal shows the other's results. MyeloTrack's job is to be the one
place where the whole picture lives.

```
┌──────────────────────────────────────────────────────────────┐
│  Client (prototype/index.html today → PWA / native later)      │
│  Today · Meds · Labs · Pallor · Score · Trends · Settings      │
└───────────────┬────────────────────────────────────────────────┘
                │  HTTPS (JSON, bearer token)
        ┌───────▼────────┐
        │  Express API    │  Node 20 + Express 4
        │  /api/v1/*      │
        └───┬───────┬─────┘
            │       │
   ┌────────▼──┐  ┌─▼──────────────────────────────────────────┐
   │ Cloud SQL  │  │ Integration workers (scheduled + on-demand) │
   │ Postgres   │  │  • MSK        → Epic FHIR R4 (SMART/OAuth)  │
   │ (RLS/user) │  │  • Capital H. → Epic FHIR R4 (SMART/OAuth)  │
   └────────────┘  │  • Apple Health → HealthKit export (client) │
                   └─────────────────────────────────────────────┘
```

## Components

### 1. Client (`web/`)

The client is a framework-free **Vite + vanilla JS** app under `web/`,
decomposed into modules (`web/src/{data,state,lib,ui,views}`) with a central
observable store and a hash router. State is in-memory and seeded on load; no
network calls yet. It is deliberately framework-free so it stays small and
portable. When it graduates to a real app, the intended path is a PWA
(installable, offline-capable via a service worker + IndexedDB cache) before
any native wrapper. Native only becomes necessary for deeper HealthKit access
and reliable background sync.

The store's field names deliberately mirror the `server/` API responses and the
database schema, so swapping the seeded in-memory store for real API calls is a
data-source change, not a reshape.

Four tabs:

- **Today** — daily symptom check-in built on the **MPN-SAF TSS** (Myelo­proliferative
  Neoplasm Symptom Assessment Form Total Symptom Score): ten items (fatigue,
  early satiety, abdominal discomfort, inactivity, concentration, night sweats,
  itching, bone pain, fever, unintentional weight loss), each 0–10. The daily
  total (0–100) is the headline trend. Plus today's due medications and a
  weight entry.
- **Meds** — the regimen (e.g. ruxolitinib, folic acid, allopurinol, plus
  supportive meds) with per-dose logging and a rolling adherence percentage.
- **Labs** — CBC-centric lab aggregation _across care teams_. Hemoglobin,
  platelets, WBC, ANC, and peripheral blasts trended over time with the source
  institution tagged on every value. This is the core differentiator.
- **Pallor** — periodic eye (palpebral conjunctiva) photos as a rough,
  at-home proxy for anemia progression between draws. Capture, store, and
  eyeball the trend; never a diagnostic, always "flag it for the next call."

### 2. Backend API (Express)

Stateless JSON API. Every PHI route is scoped to the signed-in patient:
`requireAuth` verifies the session and binds `req.repo` to
`repo.forUser(userId)`, so a controller can only reach that patient's data.
It is a patient-facing app, not a clinic system: no user can see another's
record. Sign-up and sign-in use a passkey (WebAuthn, discoverable credentials)
or an email + password; either one, used while signed out, creates a new
account. Passwords are hashed with scrypt, and failed password sign-ins are
rate-limited per IP and per email (in-process; move to shared storage before
running many instances). `ALLOW_SIGNUP=false` closes sign-up to signed-out
visitors so a public URL can't be used to open accounts.

Storage sits behind a repository interface with two implementations, chosen by
`DATA_BACKEND`: `memory` (local dev, seeded sample data) and `postgres`
(production, Cloud SQL). Production refuses to start unless sign-in is on, the
backend is Postgres, and the encryption and session secrets are set. See
[`database-schema.md`](database-schema.md) for the isolation model.

```
GET    /api/v1/auth/me                 # signed in? any accounts? sign-up open?
POST   /api/v1/auth/password/signup    # new account: email + password
POST   /api/v1/auth/password/login     # sign in: email + password
PUT    /api/v1/auth/password           # signed in: add/change email + password
GET    /api/v1/auth/{registration,authentication}/options  # passkey ceremonies
POST   /api/v1/auth/{registration,authentication}/verify
POST   /api/v1/auth/logout
GET    /api/v1/symptoms?from=&to=      # daily MPN-SAF entries
POST   /api/v1/symptoms                # create/replace today's entry
GET    /api/v1/medications             # regimen
POST   /api/v1/medications/:id/doses   # log a dose (taken / skipped / late)
GET    /api/v1/labs?analyte=&source=   # aggregated results, filterable
GET    /api/v1/labs/analytes           # distinct analytes seen
POST   /api/v1/labs/import             # save results parsed from MyChart PDFs
GET    /api/v1/pallor                  # photo entries (metadata + signed URLs)
POST   /api/v1/pallor                  # upload a new photo (multipart → object store)
GET    /api/v1/integrations/:source/connect   # begin SMART auth → { authorizeUrl }
GET    /api/v1/integrations/:source/callback  # OAuth redirect: exchange code, store tokens
POST   /api/v1/integrations/:source/sync   # pull latest (real FHIR sync when connected)
GET    /api/v1/integrations/status     # last-sync + connection health per source
```

The SMART on FHIR flow is implemented: `connect` builds a PKCE + `state`
authorize URL, `callback` exchanges the code and stores **encrypted** tokens
(AES-256-GCM, `FIELD_ENCRYPTION_KEY`), and `sync` pulls laboratory
`Observation`s, normalizes them by LOINC, and idempotently upserts by
`provenance.externalId`. The auth/exchange/fetch/normalize logic is unit-tested
with an injected `fetch`; connecting to a live Epic endpoint needs sandbox
credentials (per-source env vars — see `server/.env.example`).

Conventions: bearer token in `Authorization`, ISO-8601 timestamps in UTC,
cursor pagination on list endpoints, and every lab/observation carries a
`source` and a `provenance` block (see schema) so aggregated data never loses
track of where it came from.

### 3. Integration workers

Each external source is an independent worker with its own OAuth token store and
its own sync cadence. A pull normalizes the upstream payload into MyeloTrack's
canonical `labResults` / `observations` shape and upserts by a stable
source-scoped identifier so re-syncs are idempotent (no duplicate rows).

#### MSK — Epic FHIR R4 (SMART on FHIR)

MSK runs Epic. Patient-facing access is via **SMART on FHIR** using the
`patient/*.read` scopes over the standard R4 endpoints:

- `Patient` — demographics / MRN reconciliation
- `Observation?category=laboratory` — CBC and chemistry results
- `DiagnosticReport` — grouped panels + any narrative
- `MedicationRequest` — the prescribed regimen (reconcile against manual entries)
- `Observation?category=vital-signs` — weight, etc.

Auth is the SMART standalone-launch OAuth2 flow (PKCE), refresh-token backed.
LOINC codes drive analyte mapping (e.g. Hemoglobin `718-7`, Platelets `777-3`,
Leukocytes `6690-2`, Neutrophils absolute `751-8`, Blasts/100 leukocytes
`709-7`, Creatinine `2160-0`, eGFR `98979-8`, BUN `3094-0`, AST `1920-8`, ALT
`1742-6`, LDH `2532-0`, Uric acid `3084-1`, Urine albumin/creatinine `9318-7`).
We store the raw LOINC alongside our internal analyte key. The analyte
catalog lives in `web/src/data/analytes.js`, mirrored by
`server/src/data/analytes.js` (a test keeps them in sync).

#### MyChart PDF import (works today, no API access needed)

Until SMART on FHIR is live, results come in from MyChart printouts: the
"Test Details" page for a panel (CBC, CMP, …) and the "Result Trends" page for
one test's history. The PDF is read **in the browser** with pdf.js
(`web/src/lib/mychart/`) — its bytes never leave the device — and only the
parsed values go to `POST /api/v1/labs/import`. Every result keeps its own
lab-printed reference range, so flags match what MyChart showed.

The server owns everything derived (unit, LOINC, flag) and the dedup key,
`mychart:<source>:<analyte>:<YYYY-MM-DD>` in `provenance.externalId`: one draw
per test per care team per day. Re-importing a printout is a no-op, and a
date-only Trends row never overwrites a draw already stored with its exact
collection time. Components MyeloTrack doesn't track, and values printed in an
unexpected unit, are skipped rather than guessed at.

#### Capital Health — Epic FHIR R4

Capital Health also runs Epic, so it's the _same_ SMART-on-FHIR integration
class pointed at a different base URL and registered as a separate OAuth client.
The two configs differ only in endpoints, client IDs, and token stores — the
normalization layer is shared. This is why "aggregate labs across care teams"
is tractable: both speak R4, so once each is connected the merge is just
dedup-by-provenance on a common schema.

#### Apple Health — HealthKit

Weight, and where available lab values the user has synced into Health, come
from **HealthKit** on the client. HealthKit has no server API, so this is a
client-side export: the app requests read permission for the relevant
`HKQuantityType`s, reads samples, and posts them to `/api/v1/labs` (or a
dedicated `/observations`) tagged `source: "apple-health"`. In the web
prototype this is stubbed; it requires the native/PWA-with-native-bridge build.

### Getting API access

FHIR access is not open — each health system vets app registrations. The path:

1. Register in the vendor's developer program (Epic: **fhir.epic.com** →
   "App Orchard" / the current developer portal). Create a patient-facing
   SMART app, declare the R4 scopes above, get sandbox credentials first.
2. Ask each institution's Health Information Management / patient-portal team
   to enable the app for the patient's own record. As the patient (or their
   authorized representative), you have a right to your data — lead with that.

Outreach email template:

> **Subject:** Patient API (FHIR) access request — my own medical records
>
> Hello,
>
> I'm a patient at [MSK / Capital Health] (MRN [____]) managing a
> myeloproliferative condition, and I'm consolidating my own lab results and
> medication list across the care teams I see. I'd like to connect a personal
> application to my record using your patient-facing SMART on FHIR API
> (FHIR R4, `patient/*.read` scopes only — read-only, my data only).
>
> Could you point me to the right team or developer-portal process to register a
> patient app and enable it for my record? Happy to complete any verification you
> require. Thank you for helping me keep an accurate, unified picture of my care.
>
> [Name] · [DOB] · [portal login email] · [phone]

## Data sensitivity & compliance

This is PHI. Non-negotiables before any real backend serves real data:

- **Encryption at rest** — Cloud SQL (encrypted at rest by default; CMEK if
  policy requires); field-level AES-256-GCM for OAuth tokens; pallor photos
  encrypted in-process, then stored in Cloud Storage, never in the DB.
- **Per-patient isolation** — repository scoping plus Postgres row-level
  security on every PHI table (see `database-schema.md`).
- **Encryption in transit** — TLS everywhere; HSTS; no mixed content.
- **Audit logging** — append-only log of every read/write to PHI (who, what,
  when, from where), retained per policy and never mutated in place.
- **Access control** — passkey or scrypt-hashed password sign-in, rate-limited
  password attempts, HttpOnly signed session cookies (14 days). OAuth refresh tokens for the FHIR sources stored encrypted
  and never returned to the client.
- **HIPAA-compliant hosting** — Google Cloud under its **BAA**, using only
  products on Google's HIPAA-covered list (Cloud Run, Cloud SQL, Cloud Storage,
  Secret Manager, Cloud KMS, Cloud Logging; checked November 2026). Firebase
  is not on that list, so it is not used for PHI.
- **Data minimization** — pull only the analytes and resources the app uses;
  don't hoard the whole record.

Status (November 2026): passkey and password sign-in, per-patient isolation (code + RLS),
the append-only audit table, encrypted tokens and images, and the
production start-up guard are implemented. Still to do before real patients:
signing the BAA under the owning entity, CMEK and retention decisions, and
keeping PHI out of application logs and error tracking.
