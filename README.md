# LeadOps: a multi-source lead pipeline

All 14 mandatory edge cases pass, plus 2 interaction cases we added after finding real
bugs in the seams between them. Reproducibly, in one command.

---

## Run it

You need Docker and Node 20 or newer.

```bash
cp .env.example .env          # placeholders only, no real credential anywhere
docker compose up -d --build
./scripts/bootstrap.sh        # owner account, credentials, workflow import, activation
```

Bootstrap is safe to re-run. There are no manual setup steps: the n8n owner account, the
Postgres credential, and all eleven workflows are created and activated by script.

| Service | Where |
|---|---|
| **Operator console** | **`http://localhost:8090`**, start here |
| n8n editor | `http://localhost:5678`, credentials in `.env` |
| Mock providers and control plane | `http://localhost:8080` |
| Database | `psql -h localhost -U leadops -d leadops` |

## See it work

Open **`http://localhost:8090`**.

The console is the fastest way in. You get summary tiles, every lead with its score
breakdown and full timeline, the provider call journal, and the three human checkpoints
as actual buttons: approve or reject a VIP, work the manual review queue, replay a dead
letter. Every button drives the real workflow, so clicking Reject twice gets suppressed
as a duplicate exactly as a provider redelivering would.

The `run now` buttons trigger each queue consumer on demand. They run on a one-minute
schedule anyway; the buttons just save you waiting while someone is watching.

```bash
./scripts/demo.sh                          # narrated walkthrough of a single lead
node 05_Test_Evidence/run-edge-cases.mjs   # every edge case, pass or fail
node scripts/ops-report.mjs                # operational summary and one lead's timeline
```

The demo takes a lead from intake through scoring, routing, CRM sync and a booking. Then
it shows the two behaviours that are hard to believe without watching: a cross-source
duplicate that produces **no second message**, and a booking webhook delivered twice that
applies **once**.

## Tests

```bash
node --test 09_Lib/lib.test.mjs            # 52 tests over the pure logic
node 07_Mock_Services/selftest.mjs         # 28 tests that the mocks fail correctly
node 05_Test_Evidence/run-edge-cases.mjs   # 16 scenarios, end to end
node scripts/build-workflows.mjs --check   # fails if a workflow carries stale library code
```

---

## How it holds together

Four ideas carry most of the weight. Everything else follows from them.

**The queue is at-least-once on purpose.** Leases expire and work gets redelivered. That
isn't a flaw we tolerate, it's the design. Correctness lives in the idempotency layer
underneath, not in the transport.

**An idempotency key names an *effect*, not an *attempt*.**

```
v1:{domain}:{entity}:{id}:{occurrence}
```

Keys come only from stable inputs. Never an execution id, never a timestamp, never an
attempt counter. Two tries at the same effect collide; two different effects never do.
Replaying a workflow is therefore safe as a *consequence* of that.

**Outbound effects use claim, call, commit.** If a provider answers, the effect
definitively did not happen and retrying is safe. If there's only silence, whether a
timeout, a socket reset, or a crash between calling and recording, the outcome is
genuinely ambiguous. So we ask the provider by key instead of guessing. Guessing
double-sends or drops, and both are bad in different ways.

**Scheduled work re-reads the world when it fires.** A follow-up queued an hour ago gets
judged against consent, ownership and booking state as they are *now*. That's why
follow-ups live in a table rather than an n8n `Wait` node: a waiting execution can't be
cancelled or signalled from outside.

One more thing worth knowing. Exactly two workflows may touch a third party: one sends
messages, one writes to the CRM. Single enforcement points are the point, because a
protocol implemented in five places is enforced in none.

The full reasoning lives in [`03_Technical_Design/technical-design.md`](03_Technical_Design/technical-design.md).

---

## Layout

| Path | What's in it |
|---|---|
| `02_Workflows/` | Eleven n8n workflow exports, importable as they are |
| `03_Technical_Design/` | The SRS: assumptions, schema, integrations, idempotency, limitations |
| `04_Architecture/` | System and idempotency lifecycle diagrams |
| `05_Test_Evidence/` | Edge case harness, results transcript, screenshots |
| `06_Sample_Data/` | Payloads for driving the system by hand |
| `07_Mock_Services/` | Odoo, WhatsApp, enrichment, LLM, booking, plus the fault control plane |
| `08_Database/` | Schema, views, fixtures |
| `09_Lib/` | Pure logic, unit tested, injected into Code nodes by the build script |
| `10_Operator_Console/` | Operator UI: summary, lead timelines, approvals, DLQ replay |
| `scripts/` | Bootstrap, demo, ops report, workflow build, canvas annotation |

Every n8n canvas carries sticky notes explaining what it does and which edge case forced
it. Without them a canvas is five boxes in a line and the reasoning stays hidden inside
Code nodes nobody opens. Regenerate them with `node scripts/annotate-workflows.mjs`.

### The workflows

| Workflow | What it's responsible for |
|---|---|
| `wf-01/02/03-intake-*` | Website, WhatsApp, CSV. Normalise, key, enqueue, acknowledge |
| `wf-10-pipeline-core` | Dedup, enrichment, scoring, AI classification, routing, assignment |
| `wf-20-outbound-dispatch` | The only workflow that sends messages |
| `wf-21-odoo-sync` | The only workflow that writes to the CRM |
| `wf-30-scheduler-tick` | Follow-ups, SLA checks, approval expiry |
| `wf-40/41` | Booking webhook, VIP approval callback |
| `wf-50/51` | Error handler, safe dead-letter replay |

---

## Configuration

Everything tunable lives in `.env`. Thresholds and endpoints reach workflows as `$env.*`,
so nothing is baked into an exported workflow and swapping a mock for a real provider is
a one-line base URL change.

| Variable | Default | What it does |
|---|---|---|
| `DEDUP_AUTO_MERGE_THRESHOLD` | `0.90` | Above this, duplicates merge automatically |
| `DEDUP_REVIEW_THRESHOLD` | `0.65` | Between the two, a human decides |
| `SCORE_QUALIFIED_MIN` / `SCORE_VIP_MIN` | `70` / `90` | Band boundaries |
| `SLA_MINUTES` | `30` | Qualified lead with no sales action |
| `VIP_APPROVAL_ON_TIMEOUT` | `escalate` | `escalate`, `send`, or `hold`. See below |
| `FOLLOWUP_TIME_SCALE` | `1` | Compresses follow-up intervals for demos |
| `RETRY_BASE_MS` / `RETRY_CAP_MS` | `2000` / `900000` | Full-jitter backoff bounds. See below |
| `RETRY_MAX_ATTEMPTS` | `5` | Attempts before an effect is dead-lettered |

**`VIP_APPROVAL_ON_TIMEOUT` is a business decision, not an engineering one.** When a
manager never answers a VIP approval, sending anyway risks an unapproved message to a
strategic account, and holding risks silence on the highest-value lead in the funnel.
There's no correct answer here, only a risk appetite. The default fails closed and
escalates to a second approver. An unrecognised value also fails closed.

**`RETRY_CAP_MS` never binds at the default attempt count.** Backoff is
`random(0, min(2000 × 2^attempt, cap))`, so five attempts top out around 64 seconds and
the 15-minute cap is never reached. It's a ceiling for higher `RETRY_MAX_ATTEMPTS`, kept
deliberately so that raising the attempt count stays bounded.

**`FOLLOWUP_TIME_SCALE` exists because nobody sits through the real cadence.** Qualified
leads get chased at 1 hour, 24 hours and 72 hours; nurture leads at 3, 10 and 30 days.
Setting this to `0.002` turns the first touch into about seven seconds. The sequence
being demonstrated doesn't change, only the clock.

---

## Secrets

No real credential appears anywhere in this repository. `.env.example` holds
placeholders, `.env` is git-ignored, and it was never committed.

The n8n Postgres credential gets assembled from `.env` at bootstrap into a temporary
file, imported, then deleted from both the host and the container. It's stored encrypted
at rest under `N8N_ENCRYPTION_KEY`, which I verified by reading the ciphertext out of the
database rather than assuming.

One value has to be genuinely unguessable: the VIP approval callback token, because it
travels in a URL. Postgres generates it with `gen_random_uuid()` rather than a workflow,
because the n8n Code node sandbox has no cryptographic random source.

---
