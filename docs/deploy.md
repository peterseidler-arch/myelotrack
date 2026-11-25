# Deploying MyeloTrack to Google Cloud Run

This is the runbook for taking MyeloTrack from local-only to a live,
HIPAA-ready web app on GCP. It is a **separate** GCP project, repo, and domain
from any other project — nothing here is shared. The Google Cloud account
should belong to the legal entity that signs Google's BAA.

**Topology.** One Cloud Run service runs the Express API, which also serves the
built PWA from the same origin. Same origin means no cross-origin CORS and a
same-site session cookie. The container is defined by the repo `Dockerfile`.

```
            ┌───────────────────────── Cloud Run: "myelotrack" ─────────────┐
  Browser ──┤  Express (Node 20)                                             │
  / iOS     │   ├─ GET  /                → PWA (web/dist, static + SPA)       │
  (Capacitor)│   └─ /api/v1/*            → JSON API (audited, passkey-gated)  │
            └───────┬───────────────────────────────────┬───────────────────┘
                    │                                     │
   Cloud SQL for PostgreSQL               GCS bucket (SSE) — pallor photos
   RLS per patient, append-only audit     + Secret Manager for keys
```

**End state.** MyeloTrack runs at `https://<your-domain>` (or the default
`*.run.app` URL). Patients sign in with an email + password or a passkey; each sees only their own
record. Labs/meds/symptoms/pallor persist in Cloud SQL; pallor images live in
an encrypted GCS bucket.

**Rough cost.** Cloud Run scales to zero when idle (~$0 when unused). Cloud SQL
is always on: the smallest shared-core instance (`db-f1-micro`) is roughly
$10 a month plus storage and backups.

---

## Phase 0 — what's already done (in this repo)

- `Dockerfile` — multi-stage build (Vite PWA → static bundle; Node server with
  prod deps only; non-root; binds `$PORT`).
- The API serves the PWA at `/` and the API at `/api/v1` from one origin
  (`WEB_DIR` env, set to `/app/web/dist` in the image).
- The web client is built with `VITE_USE_API=true` so it calls the API on
  relative paths.
- Baseline security headers + `trust proxy` for correct HTTPS/WebAuthn behind
  Cloud Run.
- `.github/workflows/deploy.yml` — auto-deploy on merge to `main`, **dormant**
  until you set `DEPLOY_ENABLED=true` (see the last section).

You can build and run the exact production image locally right now:

```bash
docker build -t myelotrack:local .
docker run --rm -p 8080:8080 -e NODE_ENV=development myelotrack:local
open http://localhost:8080        # PWA + API, one origin
curl localhost:8080/healthz       # {"status":"ok","backend":"memory"}
```

With `NODE_ENV=development` and no DB it runs on in-memory sample data, a
faithful preview before any PHI is involved. In real production mode the server
refuses to start without sign-in, Postgres and secrets.

---

## Phase 1 — provision the infrastructure (one-time, needs your accounts)

Two things are yours alone: create the GCP project and link billing, and
accept Google Cloud's **HIPAA BAA** for the account. Then:

```bash
gcloud auth login
PROJECT_ID=<your-project> REGION=us-east1 bash scripts/setup-gcp.sh
PROJECT_ID=<your-project> REGION=us-east1 bash scripts/deploy.sh
```

`setup-gcp.sh` is safe to re-run. It:

1. Enables Cloud Run, Cloud Build, Artifact Registry, Secret Manager, Cloud
   Storage, Cloud SQL Admin, Compute Engine and Service Networking.
2. Creates the pallor bucket and grants the runtime service account access.
3. Creates a private network: VPC `myelotrack-vpc`, a subnet
   `myelotrack-run` for Cloud Run's Direct VPC egress, and a private services
   access range peered to Google's service network.
4. Creates a Cloud SQL for PostgreSQL 16 instance (`myelotrack-db`) with a
   **private IP only**: no public IP, TLS required, daily backups,
   point-in-time recovery, deletion protection. Then the `myelotrack`
   database and an app user `myelotrack_app` with a generated password.
5. Stores `DATABASE_URL` (the private IP, TLS on), `FIELD_ENCRYPTION_KEY` and
   `SESSION_SECRET` in Secret Manager, and grants the runtime service account
   `secretmanager.secretAccessor`.

Why private IP: health data never needs a database reachable from the
internet, and new projects often enforce the `sql.restrictPublicIp` org
policy, which rejects a public IP outright. Cloud Run reaches the database
through Direct VPC egress (`--vpc-egress=private-ranges-only`), so its other
outbound traffic, such as calls to Epic, still goes straight out.

`deploy.sh` builds from the Dockerfile and deploys with sign-in always on. On
the very first deploy it deploys privately, reads the new `*.run.app` URL,
binds passkeys to it, and only then opens public access. The server runs the
database migrations on start.

**Database role check.** Row-level security only isolates patients if the app's
role can't bypass it. The server checks this on start and refuses to run in
production if the role is a superuser or has `BYPASSRLS`. If it refuses, create
a plain role in Cloud SQL Studio or `psql`, grant it ownership of the database,
and point `DATABASE_URL` at it.

### Lock sign-up after your account exists

Open the URL, create your account (email + password, or a passkey), then close
sign-up so nobody else can open an account on your instance:

```bash
PROJECT_ID=<your-project> REGION=us-east1 ALLOW_SIGNUP=false bash scripts/deploy.sh
# or, without a rebuild:
gcloud run services update myelotrack --region=us-east1 --update-env-vars=ALLOW_SIGNUP=false
```

To let someone else in later (a reviewer, say), flip it back to `true`, have
them sign up, and close it again.

### Domain + TLS

Map your domain in Cloud Run (`gcloud run domain-mappings create`) or front it
with a load balancer. TLS certs are managed for you. Set `RP_ID` / `RP_ORIGIN`
to that domain **before** anyone registers a passkey (WebAuthn binds
credentials to the origin).

---

## Turn on auto-deploy (optional)

Once the service exists and the first manual deploy has set its config:

1. Create a deploy service account with `run.admin`, `cloudbuild.builds.editor`,
   `storage.admin`, `iam.serviceAccountUser`; download its JSON key.
2. In the GitHub repo settings:
   - Secrets: `GCP_SA_KEY` (the JSON) and `GCP_PROJECT_ID`.
   - Variables: `DEPLOY_ENABLED=true` (and optionally `GCP_REGION`).
3. Every merge to `main` now rebuilds and deploys a new revision. Until then the
   workflow is skipped, so it never shows as a failing check.

---

## Still ahead (later phases)

- **Real FHIR sources** — register Epic sandbox apps for MSK + Capital Health,
  then flip to live (the SMART-on-FHIR sync code already exists and is tested).
- **iOS** — Capacitor wrapper around the same web build → App Store.
- **Ops** — audit-log retention and export, CMEK if policy requires,
  uptime/error monitoring with no PHI in logs.

Done since the first draft: the export/delete-PHI endpoints, and the **GCS
storage backend** for pallor images — `deploy.sh` sets `STORAGE_BACKEND=gcs`
and `setup-gcp.sh` grants the runtime service account access to the bucket.
