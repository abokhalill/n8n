# LeadOps — multi-source lead pipeline

A lead-processing system built for a technical assessment: n8n orchestration, Postgres
for durable state, every external system mocked with deliberate fault injection.

**All 14 mandatory edge cases pass, reproducibly, in one command.**

---

## Run it

Requires Docker and Node 20+.

```bash
cp .env.example .env          # placeholders only 
docker compose up -d --build
./scripts/bootstrap.sh        # owner account, credentials, workflow import + activation
```

Bootstrap is idempotent; re-running it is safe. There are no manual setup steps —
n8n's owner account, the Postgres credential and all eleven workflows are created and
activated by script.

| Service | Where |
|---|---|
| n8n editor | `http://localhost:5678` (credentials in `.env`) |
| Mock providers + control plane | `http://localhost:8080` |
| Database | `psql -h localhost -U leadops -d leadops` |

## See it work

```bash
./scripts/demo.sh                          # narrated walkthrough of one lead
node 05_Test_Evidence/run-edge-cases.mjs   # all 14 edge cases, pass/fail
node scripts/ops-report.mjs                # operational summary + a lead's full timeline
```

The demo takes a lead from intake through scoring, routing, CRM sync and a booking,
then shows the two behaviours that are hard to believe without seeing: a cross-source
duplicate producing **no second message**, and a booking webhook delivered twice
applying **once**.

## Tests

```bash
node --test 09_Lib/lib.test.mjs            # 48 tests — pure logic
node 07_Mock_Services/selftest.mjs         # 28 tests — the harness itself
node 05_Test_Evidence/run-edge-cases.mjs   # 14 scenarios — end to end
node scripts/build-workflows.mjs --check   # fails if a workflow carries stale library code
```

---

## How it holds together

**The work queue is at-least-once by design.** Leases expire and work is redelivered.
Correctness comes from the idempotency layer beneath it, not from the transport.

**An idempotency key names an *effect*, not an *attempt*:**

```
v1:{domain}:{entity}:{id}:{occurrence}
```

Derived only from stable inputs — never an execution id, a timestamp, or an attempt
counter. Two tries at the same effect collide; two different effects never do.
Replaying a workflow is safe as a *consequence* of that, not as a separate feature.

**Outbound effects use claim → call → commit.** When a provider answers, the effect
definitively did not happen and retrying is safe. When there is only silence — timeout,
socket reset, a crash between calling and recording — the outcome is ambiguous, so the
provider is asked by key rather than guessed at. Guessing either double-sends or drops.

**Scheduled work re-reads the world at dispatch.** A follow-up queued an hour ago is
judged against consent, ownership and booking state as they are *now*. This is why
follow-ups live in a table rather than in an n8n `Wait` node — a waiting execution
cannot be cancelled or signalled from outside.

**Two workflows may touch a third party**: one sends messages, one writes to the CRM.
Enforcement in one place each is the point — a protocol implemented in five workflows
is enforced in none.

Full reasoning in [`03_Technical_Design/02-srs.md`](03_Technical_Design/02-srs.md).

---

## Layout

| Path | What |
|---|---|
| `02_Workflows/` | Eleven n8n workflow exports, importable as-is |
| `03_Technical_Design/` | Architecture note (pre-build) and SRS (post-build) |
| `04_Architecture/` | System and idempotency-lifecycle diagrams |
| `05_Test_Evidence/` | Edge-case harness, results transcript, ops summary example |
| `06_Sample_Data/` | Payloads for driving the system by hand |
| `07_Mock_Services/` | Odoo, WhatsApp, enrichment, LLM, booking + fault control plane |
| `08_Database/` | Schema, views, fixtures |
| `09_Lib/` | Pure logic, unit tested, injected into Code nodes by the build script |
| `scripts/` | Bootstrap, demo, ops report, workflow build |

### The workflows

| Workflow | Responsibility |
|---|---|
| `wf-01/02/03-intake-*` | Website, WhatsApp, CSV. Normalise, key, enqueue, acknowledge |
| `wf-10-pipeline-core` | Dedup, enrichment, scoring, AI classification, routing, assignment |
| `wf-20-outbound-dispatch` | The only workflow that sends messages |
| `wf-21-odoo-sync` | The only workflow that writes to the CRM |
| `wf-30-scheduler-tick` | Follow-ups, SLA checks, approval expiry |
| `wf-40/41` | Booking webhook, VIP approval callback |
| `wf-50/51` | Error handler, safe DLQ replay |

---

## Configuration

Everything tunable lives in `.env` — thresholds and endpoints are passed to workflows
as `$env.*`, so nothing is baked into an exported workflow. Swapping a mock for a real
provider is a one-line base-URL change.

| Variable | Default | Effect |
|---|---|---|
| `DEDUP_AUTO_MERGE_THRESHOLD` | `0.90` | Above this, duplicates merge automatically |
| `DEDUP_REVIEW_THRESHOLD` | `0.65` | Between the two, a human decides |
| `SCORE_QUALIFIED_MIN` / `SCORE_VIP_MIN` | `70` / `90` | Band boundaries |
| `SLA_MINUTES` | `30` | Qualified lead with no sales action |
| `VIP_APPROVAL_ON_TIMEOUT` | `escalate` | `escalate` \| `send` \| `hold` — see below |
| `FOLLOWUP_TIME_SCALE` | `1` | Compresses follow-up intervals for demos |
| `RETRY_BASE_MS` / `RETRY_CAP_MS` | `2000` / `900000` | Full-jitter backoff bounds |

**`VIP_APPROVAL_ON_TIMEOUT` is a business decision, not an engineering one.** If a
manager never answers a VIP approval, sending anyway risks an unapproved message to a
strategic account; holding risks silence on the highest-value lead in the funnel. The
default fails closed and escalates to a second approver. An unrecognised value also
fails closed.

**`FOLLOWUP_TIME_SCALE`** exists because the real cadence is 1h/24h/72h for qualified
leads and 3d/10d/30d for nurture, which nobody sits through in a walkthrough. `0.002`
turns the first touch into about seven seconds. The sequence is unchanged, only the
clock.

---

## Secrets

No real credential appears in this repository. `.env.example` carries placeholders;
`.env` is git-ignored and was never committed. The n8n Postgres credential is assembled
from `.env` at bootstrap into a temporary file, imported, then deleted from both host
and container — and stored encrypted at rest under `N8N_ENCRYPTION_KEY`.

The one value that must be unguessable — the VIP approval callback token — is generated
by Postgres `gen_random_uuid()` rather than in a workflow, because the n8n Code node
sandbox has no CSPRNG.

---

## What was deliberately cut

- **Operational summary is a SQL view plus a reporting script, not a dashboard.** It
  answers every question the brief asks; a dashboard is presentation work.
- **Email is a `channel` field on the existing dispatcher**, not a second integration.
  The claim/commit and hold logic are channel-agnostic.
- **Dedup candidate blocking is exact-match** on phone, email, name or company. A
  typo'd name with no other matching field is missed. Production wants trigram
  blocking; the scoring that follows is unchanged.
- **Phone normalisation covers six dial plans** with a hand-rolled parser rather than
  libphonenumber-js, which the Code node sandbox cannot load without a custom image.
- **Queue mode is off by default.** The SQL is written for concurrent workers; enabling
  it is a compose profile, not a redesign.

The largest mock-to-production divergence: **real Odoo has no idempotency-key header.**
The mock implements one, so the demo is cleaner than production would be. The
production design is the same shape — client-side claim plus a reconciliation search on
an indexed custom field — only the reconciliation read is more expensive.
