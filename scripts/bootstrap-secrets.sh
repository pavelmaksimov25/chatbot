#!/usr/bin/env bash
# Transforms the local gitignored .env into the k8s Secrets the cluster consumes.
# Idempotent: re-running applies the current .env values.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
NS="${NS:-chatbot}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found — copy .env.example to .env first" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

required=(
  POSTGRES_PASSWORD API_DB_PASSWORD USER_SERVICE_DB_PASSWORD
  VALKEY_PASSWORD MINIO_ROOT_USER MINIO_ROOT_PASSWORD VAULT_DEV_ROOT_TOKEN
)
missing=()
for var in "${required[@]}"; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
if ((${#missing[@]})); then
  echo "error: missing required values in $ENV_FILE: ${missing[*]}" >&2
  exit 1
fi

kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS"

apply_secret() {
  local name=$1
  shift
  kubectl --namespace "$NS" create secret generic "$name" "$@" \
    --dry-run=client -o yaml | kubectl --namespace "$NS" apply -f -
}

apply_secret chatbot-postgres \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=API_DB_PASSWORD="$API_DB_PASSWORD" \
  --from-literal=USER_SERVICE_DB_PASSWORD="$USER_SERVICE_DB_PASSWORD"

apply_secret chatbot-valkey \
  --from-literal=VALKEY_PASSWORD="$VALKEY_PASSWORD"

apply_secret chatbot-minio \
  --from-literal=MINIO_ROOT_USER="$MINIO_ROOT_USER" \
  --from-literal=MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD"

apply_secret chatbot-vault \
  --from-literal=VAULT_DEV_ROOT_TOKEN="$VAULT_DEV_ROOT_TOKEN"

# External credentials: created even when values are still empty placeholders —
# the slices that consume them fail loudly at use, not at deploy.
apply_secret chatbot-llm \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  --from-literal=GEMINI_API_KEY="${GEMINI_API_KEY:-}"

apply_secret chatbot-auth0 \
  --from-literal=AUTH0_DOMAIN="${AUTH0_DOMAIN:-}" \
  --from-literal=AUTH0_CLIENT_ID="${AUTH0_CLIENT_ID:-}" \
  --from-literal=AUTH0_CLIENT_SECRET="${AUTH0_CLIENT_SECRET:-}" \
  --from-literal=SESSION_SECRET="${SESSION_SECRET:-}"

echo "secrets bootstrapped into namespace '$NS'"
