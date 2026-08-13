# Technical Design / SRS

Written after the build, from the system that exists. Where it differs from the
pre-build design note (`01-architecture.md`), this document is authoritative.

---

## 1. Assumptions

1. Hundreds of leads/day. Justifies Postgres-as-queue and a one-minute tick; above
   ~10⁵/day the tick becomes the bottleneck and wants a broker.
2. A lead's identity is a person, not a submission. Two submissions from one human are
   one lead with two source events.
3. Consent is per-channel and revocable at any time, including while work is scheduled.
   It is read at dispatch, never cached into queued work.
4. Sales reps and capacity live in our store (`030_seed.sql`). Production reads this
   from the CRM; local seeding makes workload routing demonstrable without a live Odoo.
5. **"Sales action" means an explicitly logged rep action** — a recorded contact attempt
   or a human stage advance. Viewing a record does not count. The brief does not define
   this; a narrow definition is chosen because a broad one makes the SLA unenforceable.
6. **"Materially conflict" means the AI label and the deterministic band are more than
   one band apart with confidence ≥ 0.6.** Also undefined in the brief.
7. The booking provider supplies a stable booking ID.
8. Multiple n8n workers may run concurrently. Nothing assumes single-threaded execution.
9. Clock authority is Postgres — all scheduling uses `now()` in the database, so skew is
   impossible by construction.
10. Mocked providers support lookup by idempotency key. §11 records where real ones do not.

---

## 2. Architecture

Eleven n8n workflows over a Postgres state store, all external systems mocked.

```
sources ──▶ intake (×3) ──▶ work_queue ──▶ pipeline-core ──▶ work_queue
                                                                  │
                                          ┌───────────────────────┼──────────────────┐
                                          ▼                       ▼                  ▼
                                  outbound-dispatch         odoo-sync         scheduler-tick
                                   (only sender)         (only CRM writer)  (follow-up/SLA/expiry)
```

Diagrams in `04_Architecture/`. Canvas screenshots in `05_Test_Evidence/`.

**The queue is at-least-once by design** — leases expire and work is redelivered.
Correctness comes from the idempotency layer beneath it, not the transport.

**Workflows split at three boundaries:** trust (each source has its own auth and payload
shape), retry (n8n retries a whole execution, never a suffix), and time (anything
happening later cannot share an execution with anything happening now).

---

## 3. Workflows

| Workflow | Trigger | Responsibility |
|---|---|---|
| `wf-01/02/03-intake-*` | Webhook | Normalise, key, persist, enqueue, acknowledge |
| `wf-10-pipeline-core` | Cron 1m + ops tick | Dedup, enrichment, scoring, AI classification, routing, assignment |
| `wf-20-outbound-dispatch` | Cron 1m + ops tick | The only workflow that sends messages |
| `wf-21-odoo-sync` | Cron 1m + ops tick | The only workflow that writes to Odoo |
| `wf-30-scheduler-tick` | Cron 1m + ops tick | Follow-ups, SLA checks, approval expiry |
| `wf-40-booking-webhook` | Webhook | Booking events, keyed on the provider's booking id |
| `wf-41-approval-callback` | Webhook | VIP approve/reject, keyed on the approval token |
| `wf-50-error-handler` | Error Trigger | Unhandled failures → dead letter |
| `wf-51-dlq-reprocess` | Manual + webhook | Safe operator replay |

Each consumer also exposes an `ops/tick/*` webhook so tests and demos need not wait for
the schedule.

**Intake does no processing** beyond normalisation — that is what lets two sources
arriving together be reconciled once, downstream, rather than racing.

**`wf-10` performs no external writes.** Its only outbound calls are two reads;
everything side-effecting is enqueued for the dispatcher that owns it. That is what
makes the pipeline safe to re-run.

---

## 4. Data schema

Ten tables (`08_Database/migrations/010_schema.sql`). Two constraints do the work:

- `lead_source_event.source_event_key UNIQUE` — inbound suppression; keeps `lead_id`
  stable across redelivery, which every downstream key depends on.
- `idempotency_claim.key PRIMARY KEY` — the atomic claim for outbound effects.

| Table | Purpose |
|---|---|
| `lead` | Canonical record; `version` carries optimistic concurrency |
| `lead_source_event` | Raw payload archive **and** intake idempotency |
| `idempotency_claim` | Claim/commit ledger for every external effect |
| `work_queue` | Durable timer wheel for all deferred work |
| `dead_letter` | Terminal failures with replay lineage |
| `duplicate_decision` | Every dedup verdict with its full feature vector |
| `sales_rep` | Capacity, categories, regions, availability |
| `approval_request` | VIP gate; token from `gen_random_uuid()` |
| `event_log` | Append-only audit, enforced by trigger |
| `app_config` | Runtime values a SQL view needs; synced from `.env` by bootstrap |

Views: `ops_summary`, `lead_timeline`, `claims_needing_reconciliation`, and
`outbound_message` — a view over `idempotency_claim` rather than a table, because the
send ledger and the idempotency ledger are the same facts.

**Raw is preserved alongside normalised everywhere** (`phone_raw` / `phone_e164`).
Normalisation is lossy and a dedup dispute needs the original bytes.

---

## 5. Business rules and scoring

Deterministic, versioned (`SCORE_MODEL_VERSION = 'v1'`), fully attributable —
`score_breakdown` stores `{rule_id, points, reason}` and reconciles to the final score,
cap included.

| Rule | Points | Basis |
|---|---:|---|
| `company_size` | 0–20 | ≥1000→20, ≥250→15, ≥50→10, ≥10→5 |
| `industry_fit` | 0–10 | manufacturing, logistics, healthcare |
| `service_interest` | 0–15 | implementation 15, consulting 12, training 6, support 4 |
| `budget_band` | 0–20 | Stated budget; company revenue only as fallback |
| `timeline` | 0–15 | immediate 15, this_quarter 10, six_months 5, exploring 0 |
| `completeness` | 0–10 | 2 each for email, phone, company, described need, country |
| `region_served` | 0–10 | Region we serve |
| `strategic_account` | 0/15 | Enrichment flag |

Capped at 100; the cap is an audited rule so points never vanish silently.

**Bands:** ≥70 qualified · 40–69 nurture · <40 unqualified.
**VIP:** ≥90 or the strategic-account flag. **SLA:** qualified, no logged sales action
30 minutes after assignment.

### Two collisions in the brief, and how they were resolved

**Qualified vs VIP.** §5 gives ≥70 "immediate confirmation" and ≥90 "approval before an
automated sales message". A score-95 lead is both. Resolved: **a transactional
acknowledgement is not a sales action** — the ack sends, only outreach waits.

**Post-hoc VIP rejection** (edge case 12) has no stated unwind. Resolved: compensation
covers **future effects only** — cancel pending outbound and follow-ups, roll the Odoo
stage back with an explicit reason, audit it. **No retraction is sent**; already-delivered
messages cannot be recalled and a second unsolicited contact is worse than silence.

### AI classification

Orthogonal to the score, as §3.D asks. The model sees only `free_text_need`. A score
depending on a non-deterministic model could not be reproduced or regression-tested.

Disagreement is a *routing* signal: more than one band apart with confidence ≥ 0.6 sets
`conflict_flag` and routes to manual review. The predicate is versioned.

Responses are requested as **text, not JSON**, so a malformed body is ours to inspect
rather than a node crash. Empty, truncated and unparseable all degrade to score-only
with `fallback_used: true` and a specific reason.

---

## 6. Duplicate detection

**Decisive** — normalised phone exact, email exact, or email dedup-key match → 0.95.

**Identity evidence** (max 0.75): email local-part across domains 0.35, name similarity
(Jaro-Winkler) 0.25 × sim, company match 0.15.

**Circumstantial** (max 0.20): within 24h 0.10, different source 0.10. Cross-source
*raises* suspicion — edge case 1's signature is one person arriving via two channels.

> Circumstantial weights total 0.20, deliberately below the 0.25 gap between the review
> and auto-merge thresholds, so timing and source can never alone carry a merge. A unit
> test guards this against future weight edits.

**Tiers:** ≥0.90 auto-merge · 0.65–0.90 review · <0.65 distinct.

**Contradiction demotion:** a decisive match is demoted to review when contradicted —
same phone, different email *and* low name similarity. Shared office lines are real.

**On the thresholds.** They are priors, not fitted values. What is defensible is the
shape: a false merge is destructive and customer-visible, a false split is cheap and
self-healing. So the boundary sits conservatively, the ambiguous band goes to a person,
merges are non-destructive (link and supersede — nothing deleted or overwritten), and
every decision stores its feature vector so thresholds can be fitted from outcomes.

**Holds follow one rule: gate the irreversible, not the reversible.** A probable
duplicate keeps being enriched and scored; its CRM create and outbound messages wait.

Candidate blocking is exact-match on phone, email, name or company — see §11.

---

## 7. External integrations

All five providers mocked in `07_Mock_Services`: one process, namespaced routes, a fault
control plane and a call journal.

| Provider | Notes |
|---|---|
| Odoo | Honours `Idempotency-Key`; exposes lookup-by-key; enforces the stage lattice |
| WhatsApp | Honours `Idempotency-Key`; exposes lookup-by-key |
| Enrichment | Firmographics by email domain; a miss is `200 {found:false}`, not an error |
| LLM | Deterministic keyword classifier |
| Booking | Can deliver the same webhook N times |

**Fault injection is deterministic, never random** — edge case 3 is a scripted "fail
twice then succeed" a reviewer must reproduce on demand. Eight modes: `timeout`, `slow`,
`status`, `reset`, `malformed`, `empty`, `respond`, `drop_response`.

Two matter particularly. **`reset`** destroys the socket, producing `ECONNRESET` — a
different client code path than any HTTP status. **`drop_response`** lets the handler run
and mutate state, then kills the socket before the client learns anything; it is the only
way to reproduce edge case 7, because `timeout` short-circuits before the handler runs.

**The journal is the test oracle.** Every call is classified `delivered`, `replayed`,
`lookup` or `rejected`. Edge case 8 is proven by asserting the provider saw two calls and
one delivery — an outside observation.

**Odoo stage semantics.** Ranks: new 10, contacted 20, qualified 30, proposition 40,
meeting_booked 50, won/lost 100. A transition lowering the rank is refused unless it
carries `rollback_reason`. Re-setting the current stage is a no-op, so stage writes are
repeatable. Without this, a slow writer regresses a lead that has already progressed.

---

## 8. Authentication and secrets

- No real credential in the repository. `.env.example` is placeholders; `.env` is
  git-ignored and was never committed.
- Endpoints and tokens reach workflows as `$env.*`, so nothing is baked into an exported
  workflow. Swapping a mock for production is a base-URL change.
- The n8n Postgres credential is assembled from `.env` at bootstrap into a temp file,
  imported, then deleted from host and container. Stored encrypted under
  `N8N_ENCRYPTION_KEY` — verified as ciphertext in the database.
- The one value that must be unguessable — the VIP approval token — is generated by
  Postgres `gen_random_uuid()`, because the Code node sandbox has no CSPRNG.

**Not implemented:** webhook signature verification. See §11.

---

## 9. Idempotency

```
v1:{effect_domain}:{entity_type}:{entity_id}:{occurrence}
```

Derived purely from stable inputs — never an execution id, timestamp, random value or
attempt counter. **A key names an effect, not an attempt.** Key parts containing the
separator are rejected rather than silently mangled.

| Effect | Occurrence is… |
|---|---|
| `odoo.lead.create` | constant — created once |
| `msg.send` | the template slot (`welcome`, `followup.2`) |
| `odoo.stage.set` | the target stage |
| `booking.apply` | the **provider's** booking id |
| `approval.decide` | the approval token |

**Inbound suppression.** `INSERT … ON CONFLICT DO NOTHING RETURNING`; zero rows means
already handled. Consequences are gated on winning the claim while the *delivery* is
always logged — that is what makes suppression visible rather than looking like a
webhook that never arrived.

**Outbound claim/commit.** Claim before the call, settle after. The distinction that
makes retries safe:

> **A provider that answered** tells us the effect definitively did not happen — retry
> freely. **Silence** — timeout, reset, or a crash between calling and recording — is
> ambiguous, so ask the provider by key rather than guess.

Concurrency is arbitrated by the **work-queue lease**, not the claim; the claim only
records what happened. Conflating the two produced a real bug during the build.

**Replay** is not a feature. Identical keys mean every committed effect short-circuits.

**The link everything hangs on:** intake is keyed on
`source_event_key = hash(source, provider_event_id ?? payload)` with a unique index, so a
redelivery reuses the original `lead_id`. Get this wrong and every downstream key differs.

**Inbound dedup and entity dedup are separate layers.** Idempotency suppresses the same
event twice; duplicate detection resolves two events about one person.

**Entity concurrency:** the `lead` row carries `version`, and every pipeline write is
`WHERE lead_id = $1 AND version = $2`. Zero rows means another workflow wrote first, and
every dependent CTE in the same statement produces nothing — no partial application.

---

## 10. Observability, errors and human checkpoints

`event_log` is append-only, enforced by trigger. The rule: **log decisions with their
inputs, not messages.** "Routed to manual review" is unreconstructible;
`{decision, rule, score, band, ai_label, ai_confidence, predicate_version}` is not.

`lead_timeline` interleaves decisions with the effects they caused, with an
insertion-order tiebreak (several decisions share a timestamp). `ops_summary` is the
§3.J report. Both are visible in the operator console and via `scripts/ops-report.mjs`.

**Retry.** Classify before retrying: 429/408/5xx/timeout/transport are retryable; other
4xx and auth failures are terminal. Backoff is full jitter,
`random(0, min(2s × 2^attempt, 15min))`, five attempts — which tops out near 64s, so the
cap only binds at higher attempt counts. `Retry-After` beats our own computation.

n8n's built-in `retryOnFail` is unused: it retries at a fixed short interval inside the
same execution and loses state if the execution dies. Retry lives in the queue, which
means it is not visible on the canvas.

**Dead-lettering and replay.** Terminal work lands in `dead_letter` with its original
key. Replay safety is one rule: **a claim that succeeded is never touched; a claim that
failed permanently is cleared**, because that effect provably did not happen. Rows that
are not replayable work — a corrupt CSV row, an unhandled crash — stay open for a human.

**Time-based work re-validates at dispatch**, never at schedule time. This is why
follow-ups live in a table: an n8n `Wait` cannot be cancelled or signalled from outside.

| Checkpoint | Trigger | Held |
|---|---|---|
| VIP approval | score ≥ 90 or strategic account | Sales outreach only |
| Duplicate review | confidence 0.65–0.90 | CRM create and all outbound |
| AI/rules conflict | bands >1 apart, confidence ≥ 0.6 | Sales outreach and follow-ups |
| Data completion | no reachable channel | All outbound |

All four are database state machines, not waiting executions, and all are actionable in
the operator console. Approval timeout is risk appetite, not engineering:
`VIP_APPROVAL_ON_TIMEOUT` = `escalate` (default, fail closed) · `send` · `hold`. An
unrecognised value fails closed.

The SLA clock **pauses** while a VIP lead is gated — the rep is blocked from acting by
our own gate, so measuring them would escalate a breach the system caused. Once approval
lands the window runs from whichever of assignment or approval came later.

---

## 11. Testing

| Layer | Command | Scope |
|---|---|---|
| Unit | `node --test 09_Lib/lib.test.mjs` | 51 tests over the pure logic |
| Harness | `node 07_Mock_Services/selftest.mjs` | 28 assertions that the mocks fail correctly |
| End to end | `node 05_Test_Evidence/run-edge-cases.mjs` | **14 of 14 mandatory cases** |

Code nodes cannot be tested in place, so logic lives in `09_Lib` and is injected by
`scripts/build-workflows.mjs`, whose `--check` mode fails on a stale copy.

Assertions are made against **external observations** — the provider call journal, the
CRM mock's record count — not against what the pipeline reports about itself.

Two cases use simulated elapsed time rather than real waiting (a 30-minute SLA window, a
compressed follow-up cadence); both are marked in the harness.

Verified from a cold start: `docker compose down -v`, `cp .env.example .env`,
`up --build`, one bootstrap run, 14/14 — using the placeholder credentials, not
developer-generated ones.

---

## 12. Known limitations

1. **Real Odoo has no idempotency-key header.** The mock implements one, so the demo is
   cleaner than production. The production design is the same shape — client-side claim
   plus a reconciliation search on an indexed `x_idempotency_key` with a uniqueness
   constraint — only the reconciliation read is more expensive. **Largest divergence.**
2. **The mock enforces the stage lattice; real Odoo will not.** Mitigated by implementing
   the guard client-side in `wf-21` as well; the 409 is an assertion aid.
3. **Dedup blocking is exact-match** on phone, email, name or company. A typo'd name with
   no other matching field is missed. Production wants trigram or phonetic blocking.
4. **Dedup thresholds are unfitted priors.** Mitigated by storing every feature vector.
5. **Phone normalisation covers six dial plans** with a hand-rolled parser. Production
   wants libphonenumber-js, which the Code node sandbox cannot load without a custom image.
6. **No webhook signature verification.** Production needs per-source verification
   (Meta's `X-Hub-Signature-256`, a shared secret for the website form).
7. **Postgres-as-queue is volume-bounded**; the one-minute tick binds first.
8. **The 30-minute SLA fires at 30–31 minutes** because of tick granularity. The
   threshold is authored in `.env`; a SQL view cannot read that, so bootstrap syncs it
   into `app_config`. Changing `SLA_MINUTES` requires re-running bootstrap.
9. **Edge case 12's compensation is deliberately partial** — only future effects.
10. **Mock providers share one process**, so they are not independent failure domains.
    `reset` covers the transport-failure class.
11. **Queue mode is off by default.** The SQL is written for concurrent workers; enabling
    it is a compose profile.
12. **Email is a `channel` field** on the existing dispatcher, not a second integration.
13. **The evidence harness tests one fault at a time**, inheriting the brief's framing. It
    cannot find interactions between individually-correct subsystems — the VIP/SLA clock
    bug was found by review, not by the suite.

### Next, in order

1. Webhook signature verification per source.
2. Combinatorial test scenarios (VIP × SLA, duplicate × booking, opt-out × retry).
3. Trigram blocking, then fit the dedup thresholds once labelled merges exist.
4. libphonenumber-js via a small custom n8n image.
5. Queue mode plus a second worker.
6. Alerting on `claims_needing_reconciliation` — a non-draining value there is the
   earliest signal a provider is misbehaving.
