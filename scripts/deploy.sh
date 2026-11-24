#!/usr/bin/env bash
#
# Deploy MyeloTrack to Cloud Run — first deploy and every manual one after.
# Builds the image from the repo Dockerfile via Cloud Build and rolls out a new
# revision. Run scripts/setup-gcp.sh first (APIs, bucket, secrets).
#
# Sign-in is a passkey or an email + password. Passkeys (WebAuthn) bind credentials to an exact origin, so the service
# needs to know its own public host. Sign-in is ALWAYS on (the server refuses
# to start in production without it):
#   • DOMAIN set        → use https://$DOMAIN
#   • else service URL  → reuse the existing *.run.app host
#   • else (very first) → deploy PRIVATE (no public access), read the new URL,
#                          bind passkeys to it, then open public access.
#
# Usage:
#   PROJECT_ID=<your-project> REGION=us-east1 [DOMAIN=app.example.com] \
#     [ALLOW_SIGNUP=false] bash scripts/deploy.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID to your Google Cloud project id}"
REGION="${REGION:-us-east1}"
SERVICE="${SERVICE:-myelotrack}"
SQL_INSTANCE="${SQL_INSTANCE:-myelotrack-db}"
DOMAIN="${DOMAIN:-}"
# Set ALLOW_SIGNUP=false after you have created your account(s). Left unset,
# a redeploy keeps the live service's current value (open on the first deploy).
ALLOW_SIGNUP="${ALLOW_SIGNUP:-}"

existing_url() {
  gcloud run services describe "$SERVICE" \
    --project="$PROJECT_ID" --region="$REGION" \
    --format='value(status.url)' 2>/dev/null || true
}

origin_env() {
  local host="$1"
  echo "RP_ID=$host,RP_ORIGIN=https://$host,APP_URL=https://$host,CORS_ORIGINS=https://$host"
}

HOST=""
if [ -n "$DOMAIN" ]; then
  HOST="$DOMAIN"
else
  URL="$(existing_url)"
  HOST="${URL#https://}"
fi

if [ -z "$ALLOW_SIGNUP" ]; then
  ALLOW_SIGNUP="$(gcloud run services describe "$SERVICE" \
    --project="$PROJECT_ID" --region="$REGION" \
    --format=json 2>/dev/null | python3 -c '
import json, sys
try:
    envs = json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0].get("env", [])
    print(next((e.get("value", "") for e in envs if e["name"] == "ALLOW_SIGNUP"), ""))
except Exception:
    print("")
' || true)"
  ALLOW_SIGNUP="${ALLOW_SIGNUP:-true}"
fi
echo "▸ New-account sign-up: ALLOW_SIGNUP=$ALLOW_SIGNUP"

BUCKET="${BUCKET:-${PROJECT_ID}-pallor}"
CONNECTION_NAME="$(gcloud sql instances describe "$SQL_INSTANCE" \
  --project="$PROJECT_ID" --format='value(connectionName)')"
ENV="DATA_BACKEND=postgres,STORAGE_BACKEND=gcs,STORAGE_BUCKET=$BUCKET"
ENV="$ENV,AUTH_REQUIRED=true,ALLOW_SIGNUP=$ALLOW_SIGNUP,RP_NAME=MyeloTrack"

if [ -n "$HOST" ]; then
  echo "▸ Deploying with passkeys bound to: https://$HOST"
  ENV="$ENV,$(origin_env "$HOST")"
  ACCESS="--allow-unauthenticated"
else
  echo "▸ First deploy: no public host yet. Deploying private, then binding passkeys."
  ENV="$ENV,RP_ID=localhost,RP_ORIGIN=https://localhost"
  ACCESS="--no-allow-unauthenticated"
fi

gcloud run deploy "$SERVICE" \
  --source . \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  $ACCESS \
  --add-cloudsql-instances="$CONNECTION_NAME" \
  --set-env-vars="$ENV" \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,FIELD_ENCRYPTION_KEY=FIELD_ENCRYPTION_KEY:latest,SESSION_SECRET=SESSION_SECRET:latest" \
  --quiet

URL="$(existing_url)"
if [ -z "$HOST" ]; then
  HOST="${URL#https://}"
  echo "▸ Binding passkeys to https://$HOST and opening public access…"
  gcloud run services update "$SERVICE" \
    --project="$PROJECT_ID" --region="$REGION" \
    --update-env-vars="$(origin_env "$HOST")" --quiet
  gcloud run services add-iam-policy-binding "$SERVICE" \
    --project="$PROJECT_ID" --region="$REGION" \
    --member=allUsers --role=roles/run.invoker --quiet >/dev/null
fi

echo ""
echo "✓ Deployed: $URL"
