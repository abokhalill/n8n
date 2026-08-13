#!/usr/bin/env bash
# Brings a freshly-started stack to a working state with no clicking:
# owner account, credentials, workflow import, workflow activation.
#
# Safe to re-run. Every step checks current state before acting.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -f .env ] || { echo "no .env found — run: cp .env.example .env"; exit 1; }
set -a; . ./.env; set +a

N8N="http://localhost:${N8N_PORT:-5678}"
COOKIE="$(mktemp)"
trap 'rm -f "$COOKIE"' EXIT

say() { printf '  %s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }

# Reads a field out of a JSON document on stdin without needing jq on the host.
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=$1;console.log(v==null?'':v)}catch{console.log('')}})"; }

setup_owner() {
  curl -s --max-time 20 -X POST "$N8N/rest/owner/setup" -H 'content-type: application/json' \
    -d "{\"email\":\"$N8N_OWNER_EMAIL\",\"firstName\":\"$N8N_OWNER_FIRST_NAME\",\"lastName\":\"$N8N_OWNER_LAST_NAME\",\"password\":\"$N8N_OWNER_PASSWORD\"}" \
    -o /dev/null || true
}
try_login() {
  : > "$COOKIE"
  curl -s --max-time 20 -c "$COOKIE" -X POST "$N8N/rest/login" -H 'content-type: application/json' \
    -d "{\"emailOrLdapLoginId\":\"$N8N_OWNER_EMAIL\",\"password\":\"$N8N_OWNER_PASSWORD\"}" -o /dev/null || true
  grep -q 'n8n-auth' "$COOKIE"
}

step "waiting for n8n"
# /rest/settings starts answering before n8n can report setup state, so waiting on a
# 200 is not waiting for readiness. Poll until the field itself is a real boolean.
# Every step here tolerates failure explicitly. Under `set -e` an un-guarded curl in
# a retry loop aborts the script on the first connection reset, so the loop can never
# actually retry — which only shows up on a genuinely cold start.
NEEDS_SETUP=""
for i in $(seq 1 90); do
  RAW="$(curl -s --max-time 5 "$N8N/rest/settings" 2>/dev/null || true)"
  NEEDS_SETUP="$(printf '%s' "$RAW" | jget "JSON.parse(s).data.userManagement.showSetupOnFirstLoad" || true)"
  { [ "$NEEDS_SETUP" = "true" ] || [ "$NEEDS_SETUP" = "false" ]; } && break
  [ "$i" = 90 ] && { echo "n8n never reported readiness at $N8N"; exit 1; }
  sleep 2
done
say "ready at $N8N"

step "owner account"
if [ "$NEEDS_SETUP" = "true" ]; then
  setup_owner
  say "created $N8N_OWNER_EMAIL"
else
  say "already configured"
fi

step "login"
if ! try_login; then
  # Belt and braces: if the instance reported configured but will not accept the
  # owner, attempt setup once before giving up. Beats a misleading credentials error.
  say "login rejected — attempting owner setup once"
  setup_owner
  try_login || { echo "login failed — check N8N_OWNER_* in .env"; exit 1; }
fi
say "authenticated"

step "credentials"
# Written to a temp file, copied in, then removed from both sides. Credential
# material is assembled from .env at run time and never lands in the repo.
CREDS="$(mktemp)"; chmod 600 "$CREDS"
cat > "$CREDS" <<EOF
[
  {"id":"leadopsPgCred01","name":"LeadOps Postgres","type":"postgres",
   "data":{"host":"postgres","port":5432,"database":"leadops","user":"$POSTGRES_USER","password":"$POSTGRES_PASSWORD","ssl":"disable","allowUnauthorizedCerts":false}}
]
EOF
docker compose cp "$CREDS" n8n:/tmp/creds.json >/dev/null
docker compose exec -T n8n n8n import:credentials --input=/tmp/creds.json 2>&1 | grep -iE 'success|error' | sed 's/^/  /' || true
docker compose exec -T n8n rm -f /tmp/creds.json
rm -f "$CREDS"

step "runtime config"
# A SQL view cannot read .env, so the values it needs are synced here. .env stays the
# single authored source; this keeps the database's copy from drifting.
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d leadops -q -c \
  "INSERT INTO app_config (key, value) VALUES ('sla_minutes', '${SLA_MINUTES:-30}')
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();" >/dev/null
say "sla_minutes = ${SLA_MINUTES:-30}"

step "workflows"
shopt -s nullglob
FILES=(02_Workflows/*.json)
if [ ${#FILES[@]} -eq 0 ]; then
  say "none in 02_Workflows yet — skipping"
else
  docker compose cp 02_Workflows n8n:/tmp/wf >/dev/null
  # --separate imports every *.json in the directory. Each file carries a stable
  # id, so re-running updates in place instead of creating duplicates.
  docker compose exec -T n8n n8n import:workflow --separate --input=/tmp/wf 2>&1 | grep -iE 'success|error' | sed 's/^/  /' || true
  docker compose exec -T n8n rm -rf /tmp/wf

  step "activation"
  for f in "${FILES[@]}"; do
    ID="$(jget "JSON.parse(s).id" < "$f")"
    WANT="$(jget "JSON.parse(s).active" < "$f")"
    NAME="$(jget "JSON.parse(s).name" < "$f")"
    [ -n "$ID" ] || { say "skip $(basename "$f") — no id field"; continue; }
    if [ "$WANT" != "true" ]; then say "$NAME — left inactive"; continue; fi

    # Activation targets a specific version, so read the current one back rather
    # than assuming the file's.
    VID="$(curl -s -b "$COOKIE" "$N8N/rest/workflows/$ID" | jget "JSON.parse(s).data.versionId")"
    CODE="$(curl -s -b "$COOKIE" -X POST "$N8N/rest/workflows/$ID/activate" \
      -H 'content-type: application/json' -d "{\"versionId\":\"$VID\"}" -o /dev/null -w '%{http_code}')"
    [ "$CODE" = "200" ] && say "$NAME — active" || say "$NAME — ACTIVATION FAILED (http $CODE)"
  done
fi

step "ready"
say "editor    $N8N  ($N8N_OWNER_EMAIL)"
say "mocks     http://localhost:${MOCKS_PORT:-8080}/_control/journal"
say "database  psql -h localhost -p ${POSTGRES_PORT:-5432} -U $POSTGRES_USER -d leadops"
echo
