#!/usr/bin/env bash
#
# One-time GCP provisioning for MyeloTrack — the scriptable half of
# docs/deploy.md → "Phase 1". Run this AFTER you have:
#   1. Created the GCP project and linked a billing account.
#   2. Accepted Google Cloud's HIPAA BAA for the account that owns the project.
#
# It provisions: APIs, the encrypted pallor bucket, a Cloud SQL for PostgreSQL
# instance + database + app user, and the secrets (DATABASE_URL,
# FIELD_ENCRYPTION_KEY, SESSION_SECRET). Safe to re-run: every step checks for
# existence first and never deletes or overwrites anything.
#
# Usage:
#   PROJECT_ID=<your-project> REGION=us-east1 bash scripts/setup-gcp.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID to your Google Cloud project id}"
REGION="${REGION:-us-east1}"
BUCKET="${BUCKET:-${PROJECT_ID}-pallor}"
SQL_INSTANCE="${SQL_INSTANCE:-myelotrack-db}"
SQL_TIER="${SQL_TIER:-db-f1-micro}"   # smallest; raise before real load
DB_NAME="${DB_NAME:-myelotrack}"
DB_USER="${DB_USER:-myelotrack_app}"

echo "▸ Project: $PROJECT_ID  ·  Region: $REGION  ·  Pallor bucket: $BUCKET"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "▸ Enabling APIs…"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  sqladmin.googleapis.com

echo "▸ Encrypted pallor bucket…"
if gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  echo "  exists — leaving as-is"
else
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" \
    --uniform-bucket-level-access
  echo "  created (Google-managed encryption; upgrade to CMEK/KMS if policy requires)"
fi

echo "▸ Granting the Cloud Run runtime service account access to the bucket…"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/storage.objectAdmin" >/dev/null
echo "  ${RUNTIME_SA} → objectAdmin on gs://$BUCKET"

echo "▸ Cloud SQL for PostgreSQL…"
if gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  echo "  instance $SQL_INSTANCE exists — leaving as-is"
else
  # Encrypted at rest by default. Daily backups + point-in-time recovery, and
  # deletion protection so the instance can't be dropped by accident.
  gcloud sql instances create "$SQL_INSTANCE" \
    --database-version=POSTGRES_16 \
    --edition=enterprise \
    --tier="$SQL_TIER" \
    --region="$REGION" \
    --storage-auto-increase \
    --backup-start-time=07:00 \
    --enable-point-in-time-recovery \
    --deletion-protection
  echo "  created $SQL_INSTANCE"
fi
if gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null 2>&1; then
  echo "  database $DB_NAME exists"
else
  gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"
fi
CONNECTION_NAME="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')"

echo "▸ Granting the runtime service account Cloud SQL + secret access…"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/cloudsql.client" \
  --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/secretmanager.secretAccessor" \
  --condition=None >/dev/null

echo "▸ Secrets…"
for S in DATABASE_URL FIELD_ENCRYPTION_KEY SESSION_SECRET; do
  if gcloud secrets describe "$S" >/dev/null 2>&1; then
    echo "  $S exists"
  else
    gcloud secrets create "$S" --replication-policy=automatic
    echo "  $S created (empty)"
  fi
done

# Generate the 32-byte field-encryption + session keys once, if not already set.
gen_key_if_missing() {
  local secret="$1"
  if gcloud secrets versions access latest --secret="$secret" >/dev/null 2>&1; then
    echo "  $secret already has a value — keeping it"
  else
    echo "  generating $secret"
    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" \
      | gcloud secrets versions add "$secret" --data-file=-
  fi
}
gen_key_if_missing FIELD_ENCRYPTION_KEY
gen_key_if_missing SESSION_SECRET

# The app's database user and its connection string, created together once.
# The password is generated here and only ever stored in Secret Manager.
if gcloud secrets versions access latest --secret=DATABASE_URL >/dev/null 2>&1; then
  echo "  DATABASE_URL already has a value — keeping it"
else
  echo "  creating database user $DB_USER and DATABASE_URL"
  DB_PASS="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
  if gcloud sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx "$DB_USER"; then
    gcloud sql users set-password "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASS"
  else
    gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASS"
  fi
  printf '%s' "postgresql://${DB_USER}:${DB_PASS}@/${DB_NAME}?host=/cloudsql/${CONNECTION_NAME}" \
    | gcloud secrets versions add DATABASE_URL --data-file=-
  unset DB_PASS
fi

cat <<EOF

✓ GCP is provisioned (Cloud SQL: $CONNECTION_NAME). Deploy with:

    PROJECT_ID=$PROJECT_ID REGION=$REGION bash scripts/deploy.sh

  The server runs its database migrations on start, and refuses to start if
  its database role can bypass row-level security.
EOF
