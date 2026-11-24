# MyeloTrack

Personal health-tracking app for monitoring a myeloproliferative condition
(myelofibrosis/MDS) — daily symptoms, medication adherence, lab-result
aggregation across care teams, and eye-photo pallor tracking.

> Handles personal health data. Nothing here is a live PHI backend yet — the
> app runs on seeded, in-memory sample data and talks to no external service.
> See **Data sensitivity** before that changes.

## Layout

```
myelotrack/
├─ web/       Vite + vanilla-JS client (no framework)
├─ server/    Express API (in-memory backend for dev; PostgreSQL in production)
├─ docs/      architecture.md · database-schema.md
└─ .github/   CI (lint · format · build · test)
```

npm workspaces tie `web` and `server` together; install once at the root.

## Quick start

```bash
npm install            # installs both workspaces

npm run dev            # web (Vite, :5173) + API (:8787) together
# or run them separately:
npm run dev:web
npm run dev:server

npm run build          # production build of the web client → web/dist
npm test               # server + web tests (node:test)
npm run lint           # ESLint across both workspaces
npm run format         # Prettier
```

By default the client runs fully offline on seeded in-memory data — refresh to
reset. To point it at the live API instead, set `VITE_API_BASE_URL`:

```bash
# terminal 1 — API
npm run dev:server
# terminal 2 — client wired to it
VITE_API_BASE_URL=http://localhost:8787 npm run dev:web
```

The client then hydrates its reads from the API and writes check-ins, doses,
and pallor readings back to it; if the API is unreachable it falls back to the
seed so the UI still loads. Camera-based pallor capture needs a secure context,
so use the Vite dev server (or any HTTPS host) rather than opening the file over
`file://`.

## Architecture in one paragraph

The **client** (`web/`) is framework-free vanilla JS behind a Vite build:
design tokens + component CSS, a tiny observable `store`, a hash-free tab
router, and one module per view (`today`, `meds`, `labs`, `pallor`, `risk`, `trends`). The
**server** (`server/`) is an Express API whose data access hides behind a
repository interface — an in-memory implementation (default, zero
dependencies, seeded) and a PostgreSQL implementation (Cloud SQL in
production, with row-level security per patient), selected by `DATA_BACKEND`.
All PHI access goes through `repo.forUser(userId)`, so each signed-in patient
sees only their own record. The store's fields, the API responses, and the
database schema all share the same shape, so moving the client from seed data to the live API
is a data-source swap, not a rewrite. Full detail in
[`docs/architecture.md`](docs/architecture.md) and
[`docs/database-schema.md`](docs/database-schema.md).

## Design system

- **Fonts:** Inter Tight (headlines), Inter (body) — via Google Fonts.
- **Theme:** dark, iOS-native (system colors, blur nav bar, safe-area insets).
- **No UI framework** — plain DOM helpers and CSS.

## Features

- **Today** — MPN-SAF TSS daily check-in (10 validated items → 0–100 score
  dial), weight, and today's due meds.
- **Meds** — per-dose logging (taken/skipped) and rolling adherence.
- **Meds** — add, edit or stop medications by hand, or import a PDF of a
  medication list (a table with medication / dose / schedule columns; read on
  the device, reviewed before saving). Schedule wording becomes suggested
  dose times.
- **Labs** — CBC (Hgb, platelets, WBC, ANC, blasts), kidney (creatinine, eGFR,
  BUN, urine albumin/creatinine), liver (AST, ALT), LDH and uric acid trends
  **aggregated across MSK and Capital Health**, every value tagged with its
  source institution and flagged against its own lab's range.
- **Import from MyChart** — pick MyChart "Test Details" or "Result Trends" PDFs;
  they're parsed on the device, reviewed, then saved (re-imports are no-ops).
- **Pallor** — conjunctiva eye-photo tracking with camera capture + fallback.
- **Score** — subtype-aware risk scoring (DIPSS for myelofibrosis,
  IPSET-thrombosis for ET, PV risk) from the clinical profile and labs.
- **Trends** — check-in totals and key labs over time.
- **Sign-in & onboarding** — email + password or passkey (WebAuthn) accounts,
  first-run consent. Set `ALLOW_SIGNUP=false` to stop new accounts once yours
  exist.
- **Settings** — sign-in (add/change password, sign out), units (lb/kg,
  °F/°C), clinical profile, care-team connections (SMART on FHIR to
  Epic), and "Your data": export everything or erase it.

## Progressive web app

The client is an installable PWA (via `vite-plugin-pwa`/Workbox): a web app
manifest + icons make it "Add to Home Screen"-able, and a service worker
precaches the app shell so it launches offline. API reads use a network-first
strategy with a cache fallback, so the last-known labs/meds/pallor still render
without a connection. The service worker is only active in a production build
(`npm run build` / `preview`), not in `npm run dev`.

## Data sensitivity

No real health data until it runs under a signed BAA. In production
(`NODE_ENV=production`) the server refuses to start unless sign-in is
on, the backend is Postgres with a role that can't bypass row-level security,
and the encryption and session secrets are set. See
`docs/architecture.md` → "Data sensitivity & compliance".

### Running against Postgres locally

```bash
createuser myelotrack_app --pwprompt          # a normal role, not a superuser
createdb myelotrack -O myelotrack_app
DATA_BACKEND=postgres DATABASE_URL=postgres://myelotrack_app:PASS@localhost/myelotrack \
  npm run dev:server                          # migrations run on start

# Postgres repository tests (skipped unless this is set):
DATABASE_TEST_URL=postgres://myelotrack_app:PASS@localhost/myelotrack_test npm test
```

## License

MIT — see [LICENSE](LICENSE).
