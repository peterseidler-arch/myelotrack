#!/usr/bin/env bash
#
# One-time GCP provisioning for MyeloTrack — the scriptable half of
# docs/deploy.md → "Phase 1". Run this AFTER you have:
#   1. Created the GCP project and linked a billing account.
#   2. Accepted Google Cloud's HIPAA BAA for the account that owns the project.
#
# It provisions: APIs, the encrypted pallor bucket, a private VPC, a Cloud SQL
# for PostgreSQL instance with a PRIVATE IP only (no public IP; reachable from
# Cloud Run through the VPC), the database + app user, and the secrets
# (DATABASE_URL, FIELD_ENCRYPTION_KEY, SESSION_SECRET). Safe to re-run: every step checks for
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
NETWORK="${NETWORK:-myelotrack-vpc}"
SUBNET="${SUBNET:-myelotrack-run}"           # Cloud Run Direct VPC egress
SUBNET_RANGE="${SUBNET_RANGE:-10.10.0.0/24}"
PSA_RANGE="${PSA_RANGE:-myelotrack-psa}"      # private services access (Cloud SQL)

echo "▸ Project: $PROJECT_ID  ·  Region: $REGION  ·  Pallor bucket: $BUCKET"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "▸ Enabling APIs…"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  sqladmin.googleapis.com \
  compute.googleapis.com \
  servicenetworking.googleapis.com

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

echo "▸ Private network for Cloud SQL + Cloud Run…"
if gcloud compute networks describe "$NETWORK" >/dev/null 2>&1; then
  echo "  network $NETWORK exists"
else
  gcloud compute networks create "$NETWORK" --subnet-mode=custom
fi
if gcloud compute networks subnets describe "$SUBNET" --region="$REGION" >/dev/null 2>&1; then
  echo "  subnet $SUBNET exists"
else
  gcloud compute networks subnets create "$SUBNET" \
    --network="$NETWORK" --region="$REGION" --range="$SUBNET_RANGE" \
    --enable-private-ip-google-access
fi
if gcloud compute addresses describe "$PSA_RANGE" --global >/dev/null 2>&1; then
  echo "  private services range $PSA_RANGE exists"
else
  gcloud compute addresses create "$PSA_RANGE" --global \
    --purpose=VPC_PEERING --prefix-length=20 --network="$NETWORK"
fi
if gcloud services vpc-peerings list --network="$NETWORK" --format='value(peering)' \
  | grep -q servicenetworking; then
  echo "  private services access already connected"
else
  gcloud services vpc-peerings connect --service=servicenetworking.googleapis.com \
    --ranges="$PSA_RANGE" --network="$NETWORK"
fi

echo "▸ Cloud SQL for PostgreSQL (private IP only)…"
if gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  echo "  instance $SQL_INSTANCE exists — leaving as-is"
else
  # No public IP (org policy sql.restrictPublicIp, and the right posture for
  # PHI). Encrypted at rest by default; TLS required on every connection.
  # Daily backups + point-in-time recovery, and deletion protection.
  gcloud sql instances create "$SQL_INSTANCE" \
    --database-version=POSTGRES_16 \
    --edition=enterprise \
    --tier="$SQL_TIER" \
    --region="$REGION" \
    --network="projects/$PROJECT_ID/global/networks/$NETWORK" \
    --no-assign-ip \
    --ssl-mode=ENCRYPTED_ONLY \
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
PRIVATE_IP="$(gcloud sql instances describe "$SQL_INSTANCE" --format=json | python3 -c \
  'import json,sys; print(next((a["ipAddress"] for a in json.load(sys.stdin).get("ipAddresses", []) if a.get("type") == "PRIVATE"), ""))')"
if [ -z "$PRIVATE_IP" ]; then
  echo "✗ $SQL_INSTANCE has no private IP; check its network settings." >&2
  exit 1
fi
echo "  private IP $PRIVATE_IP"

echo "▸ Letting Cloud Build build the image as the default compute service account…"
# Newer projects no longer give that account Editor, so source deploys fail
# with "does not have storage.objects.get access" on the run-sources bucket.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/cloudbuild.builds.builder" \
  --condition=None >/dev/null

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
# Connects over the VPC to the private IP; TLS on (sslmode=no-verify encrypts
# but doesn't check the server certificate's name, which is not the IP).
CURRENT_DB_URL="$(gcloud secrets versions access latest --secret=DATABASE_URL 2>/dev/null || true)"
if [ -n "$CURRENT_DB_URL" ] && [[ "$CURRENT_DB_URL" == *"@${PRIVATE_IP}:"* ]]; then
  echo "  DATABASE_URL already points at $PRIVATE_IP — keeping it"
else
  echo "  creating database user $DB_USER and DATABASE_URL"
  DB_PASS="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
  if gcloud sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx "$DB_USER"; then
    gcloud sql users set-password "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASS"
  else
    gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASS"
  fi
  printf '%s' "postgresql://${DB_USER}:${DB_PASS}@${PRIVATE_IP}:5432/${DB_NAME}?sslmode=no-verify" \
    | gcloud secrets versions add DATABASE_URL --data-file=-
  unset DB_PASS
fi

cat <<EOF

✓ GCP is provisioned (Cloud SQL private IP: $PRIVATE_IP). Deploy with:

    PROJECT_ID=$PROJECT_ID REGION=$REGION bash scripts/deploy.sh

  The server runs its database migrations on start, and refuses to start if
  its database role can bypass row-level security.
EOF
