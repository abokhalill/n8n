# Sample data

Payloads for driving the system by hand. The evidence harness in `05_Test_Evidence` uses
equivalent fixtures inline; these exist so you can poke at things directly.

| File | What it's for |
|---|---|
| `website-lead.json` | A strong lead. Scores 100, flags as VIP, gates on manager approval |
| `whatsapp-message.json` | The same person, same phone in a different format. Auto-merges with the above |
| `leads-batch.csv` | Five rows, two of them deliberately corrupt: line 3 is short, line 6 has a stray quote |
| `booking-event.json` | A booking webhook, set to deliver twice |
| `approval-callback.json` | The manager's approve or reject callback |

```bash
curl -X POST localhost:5678/webhook/intake/website  -H 'content-type: application/json' -d @06_Sample_Data/website-lead.json
curl -X POST localhost:5678/webhook/intake/whatsapp -H 'content-type: application/json' -d @06_Sample_Data/whatsapp-message.json
curl -X POST localhost:5678/webhook/intake/csv      -H 'content-type: application/json' \
     --data "$(node -e 'console.log(JSON.stringify({batch_ref:"leads-batch.csv",csv:require("fs").readFileSync("06_Sample_Data/leads-batch.csv","utf8")}))')"
```

Two files carry `REPLACE_WITH_...` placeholders, because booking and approval both key on
identifiers the system issues at runtime: a lead id and an approval token. That's
deliberate rather than an oversight. Those identifiers are exactly what make the events
idempotent, so hardcoding them would defeat the mechanism they're demonstrating.

`scripts/demo.sh` fills them in for you, and the operator console at `localhost:8090`
lets you approve or reject without touching a token at all.
