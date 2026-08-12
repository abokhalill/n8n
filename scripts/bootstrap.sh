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

step "waiting for n8n"
for i in $(seq 1 60); do
  curl -sf "$N8N/rest/settings" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "n8n never became reachable at $N8N"; exit 1; }
  sleep 2
done
say "reachable at $N8N"

step "owner account"
NEEDS_SETUP="$(curl -s "$N8N/rest/settings" | jget "JSON.parse(s).data.userManagement.showSetupOnFirstLoad")"
if [ "$NEEDS_SETUP" = "true" ]; then
  curl -s -X POST "$N8N/rest/owner/setup" -H 'content-type: application/json' \
    -d "{\"email\":\"$N8N_OWNER_EMAIL\",\"firstName\":\"$N8N_OWNER_FIRST_NAME\",\"lastName\":\"$N8N_OWNER_LAST_NAME\",\"password\":\"$N8N_OWNER_PASSWORD\"}" \
    -o /dev/null
  say "created $N8N_OWNER_EMAIL"
else
  say "already configured"
fi

step "login"
curl -s -c "$COOKIE" -X POST "$N8N/rest/login" -H 'content-type: application/json' \
  -d "{\"emailOrLdapLoginId\":\"$N8N_OWNER_EMAIL\",\"password\":\"$N8N_OWNER_PASSWORD\"}" -o /dev/null
grep -q 'n8n-auth' "$COOKIE" || { echo "login failed — check N8N_OWNER_* in .env"; exit 1; }
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
