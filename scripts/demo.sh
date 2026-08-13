#!/usr/bin/env bash
# A narrated walkthrough of one lead, end to end, plus the two failure behaviours
# that are hardest to believe without seeing: a cross-source duplicate producing no
# second message, and a booking webhook delivered twice applying once.
#
#   ./scripts/demo.sh          pauses between steps
#   ./scripts/demo.sh --fast   no pauses
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
set -a; . ./.env; set +a

N8N="http://localhost:${N8N_PORT:-5678}"
MOCKS="http://localhost:${MOCKS_PORT:-8080}"
PAUSE=${1:-}

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
beat() { [ "$PAUSE" = "--fast" ] || { printf '\n   (enter to continue) '; read -r _; }; }
pq()   { docker compose exec -T postgres psql -U "$POSTGRES_USER" -d leadops -tAc "$1"; }
tick() { curl -s -X POST "$N8N/webhook/ops/tick/$1" -H 'content-type: application/json' -d '{}' >/dev/null; }

say "Resetting to a clean state"
pq "TRUNCATE lead_source_event, work_queue, event_log, duplicate_decision, approval_request,
    dead_letter, idempotency_claim, lead RESTART IDENTITY CASCADE;
    UPDATE sales_rep SET available=true, open_leads=CASE rep_id WHEN 'rep_amara' THEN 2
      WHEN 'rep_yuki' THEN 9 WHEN 'rep_luis' THEN 3 WHEN 'rep_hana' THEN 6 ELSE 0 END;" >/dev/null
curl -s -X POST "$MOCKS/_control/reset" -H 'content-type: application/json' -d '{}' >/dev/null
note "database truncated, mock providers reset, sales roster restored"
beat

say "1. A lead arrives from the website"
RESP=$(curl -s -X POST "$N8N/webhook/intake/website" -H 'content-type: application/json' \
  -d @06_Sample_Data/website-lead.json)
LEAD=$(echo "$RESP" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).lead_id')
note "$RESP"
note ""
note "Intake acknowledged and enqueued. It did no processing at all — that is what"
note "lets two sources arriving together be reconciled once, downstream."
beat

say "2. The pipeline runs: dedup, enrichment, scoring, AI classification, routing"
tick pipeline; sleep 1
pq "SELECT '   score='||score||'  band='||score_band||'  disposition='||disposition||
    '  owner='||COALESCE(owner_id,'-')||'  vip='||vip_flag||'  approval='||approval_state
    FROM lead WHERE lead_id='$LEAD';"
note ""
note "Every point is attributable:"
pq "SELECT '     '||lpad(r->>'points',4)||'  '||rpad(r->>'rule_id',20)||' '||(r->>'reason')
    FROM lead, jsonb_array_elements(score_breakdown) r WHERE lead_id='$LEAD';"
beat

say "3. Outbound and CRM sync"
tick outbound; sleep 1; tick odoo; sleep 1; tick odoo; sleep 1
note "Messages the provider actually received:"
curl -s "$MOCKS/_control/journal?provider=whatsapp" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const e=JSON.parse(s).entries.filter(x=>x.method==="POST");
    e.forEach(x=>console.log("     "+x.request.template+" -> "+x.request.to+"  ["+x.outcome+"]"));
    if(!e.length) console.log("     (none)");
  })'
note ""
note "This lead scored 100, so it is VIP: the acknowledgement goes out, but sales"
note "outreach waits for a manager. The brief asks for both; they are not the same act."
note ""
note "CRM funnel:"
curl -s "$MOCKS/_control/state/odoo" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);
    console.log("     records: "+j.leads.length);
    j.leads.forEach(l=>console.log("     "+l.id+"  "+l.stage_history.map(h=>h.stage).join(" -> ")));
  })'
beat

say "4. The same person messages on WhatsApp — same number, different format"
curl -s -X POST "$N8N/webhook/intake/whatsapp" -H 'content-type: application/json' \
  -d @06_Sample_Data/whatsapp-message.json >/dev/null
tick pipeline; sleep 1; tick outbound; sleep 1; tick odoo; sleep 1
pq "SELECT '   '||source||'  '||rpad(dedup_status,12)||' conf='||COALESCE(dedup_confidence::text,'-')
    FROM lead ORDER BY ingested_at;"
note ""
note "Linked, not duplicated. And the part that matters:"
curl -s "$MOCKS/_control/journal/tally?provider=whatsapp" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const t=JSON.parse(s);
    console.log("     messages delivered to the customer: "+t.delivered);
  })'
curl -s "$MOCKS/_control/state/odoo" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("     CRM records: "+JSON.parse(s).leads.length))'
note ""
note "Two submissions, one person, one record, one message."
beat

say "5. A booking webhook — delivered twice, as providers do"
BEFORE=$(curl -s "$MOCKS/_control/journal/tally?provider=whatsapp" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).delivered')
MASTER=$(pq "SELECT lead_id FROM lead WHERE dedup_status <> 'merged_into' LIMIT 1;")
curl -s -X POST "$MOCKS/_control/emit/booking" -H 'content-type: application/json' \
  -d "{\"lead_id\":\"$MASTER\",\"booking_id\":\"BK-DEMO-1\",\"times\":2,\"rep_email\":\"amara@example.test\"}" \
  | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      JSON.parse(s).deliveries.forEach((d,i)=>console.log("     delivery "+(i+1)+": "+d.body));
    })'
tick odoo; sleep 1; tick outbound; sleep 1; tick odoo; sleep 1
AFTER=$(curl -s "$MOCKS/_control/journal/tally?provider=whatsapp" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).delivered')
note ""
note "Applied once. Rep notifications sent: $((AFTER - BEFORE))"
pq "SELECT '     '||kind||' -> '||state FROM work_queue WHERE state='cancelled';" || true
note "Marketing follow-up stops the moment a meeting exists."
beat

say "6. Reconstructing the whole thing"
node scripts/ops-report.mjs "$MASTER"

say "Done"
note "Full edge-case evidence:  node 05_Test_Evidence/run-edge-cases.mjs"
note "n8n editor:               $N8N"
echo
