# Sample data

Payloads for driving the system by hand. The evidence harness in `05_Test_Evidence`
uses equivalent fixtures inline; these exist so a reviewer can poke at it directly.

| File | Use |
|---|---|
| `website-lead.json` | A strong lead. Scores 100, flags VIP, gates on manager approval |
| `whatsapp-message.json` | The same person, same phone in a different format — auto-merges with the above |
| `leads-batch.csv` | Five rows, two deliberately corrupt (line 3 short, line 6 stray quote) |
| `booking-event.json` | Booking webhook, set to deliver twice |
| `approval-callback.json` | Manager approve/reject callback |

```bash
curl -X POST localhost:5678/webhook/intake/website  -H 'content-type: application/json' -d @06_Sample_Data/website-lead.json
curl -X POST localhost:5678/webhook/intake/whatsapp -H 'content-type: application/json' -d @06_Sample_Data/whatsapp-message.json
curl -X POST localhost:5678/webhook/intake/csv      -H 'content-type: application/json' \
     --data "$(node -e 'console.log(JSON.stringify({batch_ref:"leads-batch.csv",csv:require("fs").readFileSync("06_Sample_Data/leads-batch.csv","utf8")}))')"
```

Two files carry `REPLACE_WITH_...` placeholders because booking and approval both key
on identifiers the system issues at runtime — a lead id and an approval token. That is
deliberate: those keys are what make the events idempotent, so they cannot be
hardcoded. `scripts/demo.sh` fills them in for you.
