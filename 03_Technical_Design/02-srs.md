# Technical Design / SRS

Written after the build, from the system that exists. Where the implementation
diverges from the Phase 1 design note (`01-architecture.md`), this document is
authoritative and says so.

---

## 1. Assumptions

1. **Volume is low** — hundreds of leads/day. This justifies Postgres-as-queue and a
   one-minute tick. Above ~10⁵/day the tick becomes the bottleneck and wants a real
   broker. The threshold is stated so the design's expiry date is explicit.
2. **A lead's identity is a person, not a submission.** Two submissions from one human
   are one lead with two source events.
3. **Consent is per-channel and revocable at any time**, including while work is
   scheduled. It is therefore read at dispatch, never cached into queued work.
4. **Sales reps and capacity live in our store**, seeded in `030_seed.sql`. A real
   deployment reads this from the CRM; keeping it local makes workload routing and
   rep-unavailability demonstrable without a live Odoo.
5. **"Sales action" for the SLA means an explicitly logged rep action** — a recorded
   contact attempt or a stage advance by a human. Viewing a record does not count.
   The brief does not define this; a narrow definition is chosen because a broad one
   makes the SLA unenforceable.
6. **"Materially conflict" means the AI label and the deterministic band are more than
   one band apart with AI confidence ≥ 0.6.** Adjacent disagreement is noise. The
   brief does not define this either.
7. **The booking provider supplies a stable booking ID**, which is what the booking
   event is keyed on.
8. **One n8n instance, queue-mode capable.** Nothing assumes single-threaded
   execution; the SQL is written for concurrent workers.
9. **Clock authority is Postgres.** Every scheduling timestamp uses `now()` in the
   database rather than a workflow's clock, so skew is impossible by construction.
10. **Mocked providers cooperate on reconciliation** — they support lookup by
    idempotency key. §12 records where real providers do not.

---

## 2. Architecture overview

Eleven n8n workflows over a Postgres state store, with every external system mocked.

```
sources ──▶ intake (×3) ──▶ work_queue ──▶ pipeline-core ──▶ work_queue
                                                                  │
                                          ┌───────────────────────┼──────────────────┐
                                          ▼                       ▼                  ▼
                                  outbound-dispatch         odoo-sync         scheduler-tick
                                  (only sender)          (only CRM writer)   (follow-up/SLA/expiry)
```

Diagrams: `04_Architecture/system-architecture.mmd` (components, queues, human
checkpoints) and `04_Architecture/idempotency-claim-lifecycle.mmd` (the outbound
effect state machine).

**The thesis.** The work queue is *at-least-once by design* — leases expire and work is
redelivered. Correctness comes from the idempotency layer beneath it, not from the
transport. Every reliability property in this document is an application of that.

**Three boundaries decide what is a separate workflow:** trust (each source has its own
auth and payload shape, so a malformed WhatsApp body cannot break website intake),
retry (n8n retries a whole execution, never a suffix, so anything independently
retryable must be independently executable), and time (anything happening later cannot
share an execution with anything happening now).

---

## 3. Workflow breakdown

| Workflow | Trigger | Responsibility |
|---|---|---|
| `wf-01-intake-website` | Webhook | Normalise, key, persist, enqueue, acknowledge |
| `wf-02-intake-whatsapp` | Webhook | As above; keys redelivery on the provider message id |
| `wf-03-intake-csv` | Webhook | Per-row isolation; corrupt rows quarantined |
| `wf-10-pipeline-core` | Cron 1m + ops tick | Dedup, enrichment, scoring, AI classification, routing, assignment |
| `wf-20-outbound-dispatch` | Cron 1m + ops tick | The **only** workflow that sends messages |
| `wf-21-odoo-sync` | Cron 1m + ops tick | The **only** workflow that writes to Odoo |
| `wf-30-scheduler-tick` | Cron 1m + ops tick | Follow-ups, SLA checks, approval expiry |
| `wf-40-booking-webhook` | Webhook | Booking events, keyed on the provider's booking id |
| `wf-41-approval-callback` | Webhook | VIP approve/reject, keyed on the approval token |
| `wf-50-error-handler` | Error Trigger | Catches unhandled failures anywhere → dead letter |
| `wf-51-dlq-reprocess` | Manual + webhook | Safe operator replay |

Each consumer also exposes an `ops/tick/*` webhook. The cron schedule is what runs in
practice; the webhook exists so tests and demos need not wait a minute per step.

**Intake does no processing.** It normalises, derives keys, persists, enqueues, and
acknowledges. That is what lets two sources arriving together be reconciled once,
downstream, instead of racing between two webhook handlers.

**`wf-10` performs no external writes.** Its only outbound calls are two reads
(enrichment, classification). Everything side-effecting is enqueued for the dispatcher
that owns it. That is what makes the whole pipeline safe to re-run.

---

## 4. Data schema

Nine tables (`08_Database/migrations/010_schema.sql`). Two constraints do the heavy
lifting and are worth finding first:

- `lead_source_event.source_event_key UNIQUE` — inbound event suppression. This is what
  keeps `lead_id` stable across redelivery, which every downstream key depends on.
- `idempotency_claim.key PRIMARY KEY` — the atomic claim for outbound effects.

| Table | Purpose |
|---|---|
| `lead` | Canonical record. `version` column carries optimistic concurrency |
| `lead_source_event` | Raw payload archive **and** the intake idempotency table |
| `idempotency_claim` | Claim/commit ledger for every external effect |
| `work_queue` | Durable timer wheel: pipeline, outbound, odoo_sync, followup, sla_check, approval_expiry |
| `dead_letter` | Terminal failures, with replay lineage |
| `duplicate_decision` | Every dedup verdict with its full feature vector |
| `sales_rep` | Capacity, categories, regions, availability |
| `approval_request` | VIP gate state machine; token generated by `gen_random_uuid()` |
| `event_log` | Append-only audit, enforced by trigger |

Views: `ops_summary` (§10), `lead_timeline` (§10), `claims_needing_reconciliation`, and
`outbound_message` — a **view** over `idempotency_claim`, not a table, because the send
ledger and the idempotency ledger are the same facts and duplicating them would let
them disagree.

**Raw is preserved alongside normalised everywhere.** `phone_raw` next to `phone_e164`,
`email_raw` next to `email_normalized`. Normalisation is lossy and a dedup dispute needs
the bytes the customer actually typed.

Canonical lead fields, grouped: identity, contact (raw + normalised + validity),
business, consent (status/timestamp/source/channels), enrichment (with its own status,
so a *failed* lookup never reads as "company size is null"), qualification (score,
breakdown, model version, AI classification, conflict flag), routing (disposition,
owner, assignment reason, VIP, approval state), dedup (status, duplicate_of,
confidence, features), CRM (odoo ids, stage, rank), lifecycle (status, version).

---

## 5. Business rules and scoring

Deterministic, versioned (`SCORE_MODEL_VERSION = 'v1'`), and fully attributable —
`score_breakdown` stores `{rule_id, points, reason}` per rule and reconciles to the
final score, cap adjustment included.

| Rule | Points | Basis |
|---|---:|---|
| `company_size` | 0–20 | Enriched headcount: ≥1000→20, ≥250→15, ≥50→10, ≥10→5 |
| `industry_fit` | 0–10 | Target industries: manufacturing, logistics, healthcare |
| `service_interest` | 0–15 | implementation 15, consulting 12, training 6, support 4 |
| `budget_band` | 0–20 | Stated budget preferred; company revenue used only as a fallback proxy |
| `timeline` | 0–15 | immediate 15, this_quarter 10, six_months 5, exploring 0 |
| `completeness` | 0–10 | 2 points each for email, phone, company, a described need, country |
| `region_served` | 0–10 | Region is one we serve |
| `strategic_account` | 0/15 | Enrichment flag |

Raw total is capped at 100, and the cap is itself an audited rule so points never
vanish silently.

**Bands** (brief §5): ≥70 qualified · 40–69 nurture · <40 unqualified.
**VIP**: score ≥ 90 **or** the strategic-account flag.
**SLA**: a qualified lead with no logged sales action 30 minutes after assignment.

### Two rules in the brief that collide, and how they were resolved

**Qualified vs VIP.** §5 says score ≥ 70 gets "immediate confirmation" and score ≥ 90
requires manager approval "before an automated sales message". A score-95 lead
satisfies both. Resolved: **a transactional acknowledgement is not a sales action.**
The acknowledgement sends immediately; only sales outreach waits on the manager.
Withholding the acknowledgement would leave the highest-value leads in silence.

**Post-hoc VIP rejection** (edge case 12) has no stated unwind semantics. Resolved:
compensation covers **future effects only** — cancel pending outbound and follow-ups,
roll the Odoo stage back with an explicit reason, audit it. **No retraction message is
sent**, because anything already delivered cannot be recalled and a second unsolicited
contact is worse than silence.

### AI classification

Kept **orthogonal** to the score, as brief §3.D itself asks ("a *separate* qualitative
classification"). The model sees only `free_text_need`. A score that depended on a
non-deterministic model could not be reproduced, explained after the fact, or
regression-tested.

Disagreement is a *routing* signal: more than one band apart with confidence ≥ 0.6 sets
`conflict_flag` and routes to manual review regardless of score. The predicate is
versioned alongside the score model.

The model is treated as an untrusted service returning untrusted bytes — responses are
requested as **text**, not JSON, so a malformed body is ours to inspect rather than a
node crash. Empty, truncated and unparseable responses all degrade to score-only with
`fallback_used: true` and a specific failure reason.

---

## 6. Duplicate detection

Features are derived independently, weights are published, and the full vector is
stored on every decision so a threshold can be re-argued from what was actually seen.

**Decisive** — normalised phone exact, email exact, or email dedup-key match → 0.95.

**Identity evidence** (max 0.75): email local-part match across domains 0.35, name
similarity (Jaro-Winkler) 0.25 × similarity, company match 0.15.

**Circumstantial evidence** (max 0.20): submitted within 24h 0.10, different source 0.10.
Cross-source *raises* suspicion rather than lowering it — edge case 1's signature is
precisely one person arriving via two channels.

> The circumstantial weights total 0.20, deliberately less than the 0.25 gap between
> the review and auto-merge thresholds. Timing and source can move a pair within a band
> but can never, alone, carry it into an automatic merge. A unit test guards this
> invariant against future weight edits.

**Tiers**: ≥0.90 auto-merge · 0.65–0.90 manual review · <0.65 distinct.

**Contradiction demotion**: a decisive identifier match is demoted into the review band
when other evidence contradicts it — same phone, different email *and* low name
similarity. Shared office lines are real, and a rule that merges on phone alone will
eventually merge two different people.

**On the thresholds.** They are priors, not fitted values, and nothing here claims
otherwise. What is defensible is the shape: a false merge is destructive and
customer-visible, a false split is cheap and self-healing when a human merges later.
So the boundary sits conservatively, the ambiguous band goes to a person, merges are
non-destructive (link and supersede — no record deleted, no field overwritten), and
every decision stores its feature vector so the thresholds can be *fitted from
outcomes* rather than argued about. The strongest claim available is not "0.90 is
correct" but "the system is instrumented to discover what is correct."

**Governing principle for holds: gate the irreversible, not the reversible.** A probable
duplicate keeps being enriched and scored, because both can be redone. Its CRM create
and outbound messages wait for a human.

**Candidate blocking** is exact-match on phone, email, name or company — a deliberate
simplification that will miss a typo'd name with no other matching field. See §12.

---

## 7. External integrations

All five providers are mocked in `07_Mock_Services`, one process with namespaced
routes, a fault control plane and a call journal.

| Provider | Routes | Notes |
|---|---|---|
| Odoo | `/odoo/leads`, `/leads/lookup`, `/leads/:id/stage` | Honours `Idempotency-Key`; enforces the stage lattice |
| WhatsApp | `/whatsapp/messages`, `/messages/lookup` | Honours `Idempotency-Key` |
| Enrichment | `/enrich` | Firmographics by email domain; a miss is `200 {found:false}` |
| LLM | `/ai/classify` | Deterministic keyword classifier |
| Booking | `/booking/:id` + control-plane emitter | Can deliver the same webhook N times |

**Fault injection is deterministic and directive-driven, never random.** Edge case 3 is
a scripted "fail twice then succeed"; a reviewer must be able to reproduce it on demand,
not wait for it. Eight modes: `timeout`, `slow`, `status`, `reset`, `malformed`, `empty`,
`respond`, `drop_response`.

Two of those deserve comment. **`reset`** destroys the socket, producing `ECONNRESET` —
the "service is down" error class, which travels a different code path than any HTTP
status. **`drop_response`** lets the handler run and mutate state, then kills the socket
before the client learns anything; it is the only honest way to reproduce edge case 7,
because `timeout` short-circuits before the handler runs and the record is never
created at all.

**The journal is the test oracle.** Every inbound call is recorded and classified as
`delivered`, `replayed`, `lookup` or `rejected`. Edge case 8 is proven by asserting the
provider saw two calls and exactly one delivery — an outside observation, not the
pipeline reporting on itself.

### Odoo stage semantics

Stages carry a rank: new 10, contacted 20, qualified 30, proposition 40,
meeting_booked 50, won/lost 100. A transition that would lower the rank is **refused**
unless it carries an explicit `rollback_reason`. Setting the stage a lead is already in
is a no-op, not a conflict, so stage writes are safely repeatable.

This matters because stage changes are driven from qualification, follow-up, booking,
manager rejection and SLA escalation. Without ordering protection a slow writer can
regress a lead from *Meeting Booked* back to *Contacted* — a lost update that stays
invisible until someone notices the funnel is wrong.

---

## 8. Authentication and secrets

No real credential appears anywhere in the repository. `.env.example` carries
placeholders only; `.env` is git-ignored and was never committed.

- Provider endpoints and tokens reach workflows as `$env.*`, so nothing is baked into
  an exported workflow. Swapping a mock for a real base URL is a one-line env change.
- The n8n Postgres credential is assembled from `.env` at bootstrap into a temporary
  file, imported via `n8n import:credentials`, then deleted from both host and
  container. It is stored encrypted at rest under `N8N_ENCRYPTION_KEY` — verified as
  ciphertext in the database rather than assumed.
- The one value that must be **unguessable** — the VIP approval callback token — is
  generated by Postgres `gen_random_uuid()`, not in a workflow. The Code node sandbox
  has no CSPRNG, so secret material is generated where a CSPRNG exists.
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` opens env access to expressions. Only the
  variables listed in `docker-compose.yml` are passed into the container.

---

## 9. Idempotency strategy

### The key

```
v1:{effect_domain}:{entity_type}:{entity_id}:{occurrence}
```

Derived **purely** from stable inputs. Never contains an execution id, a timestamp, a
random value, or an attempt counter. A key names an **effect**, not an **attempt**: two
tries at the same effect collide, two different effects never do. Key parts containing
the separator are rejected rather than silently mangled.

| Effect | Key | Occurrence is… |
|---|---|---|
| Create the CRM lead | `v1:odoo.lead.create:lead:01J8X…:1` | constant — created once |
| Welcome message | `v1:msg.send:lead:01J8X…:welcome` | the template slot |
| Follow-up step 2 | `v1:msg.send:lead:01J8X…:followup.2` | the step index |
| Set stage | `v1:odoo.stage.set:lead:01J8X…:meeting_booked` | the target stage |
| Apply a booking | `v1:booking.apply:booking:BK-991:1` | the **provider's** booking id |
| Decide an approval | `v1:approval.decide:approval:{token}:1` | the approval token |

### Three uses, one key

**Inbound suppression.** `INSERT … ON CONFLICT DO NOTHING RETURNING`. Zero rows means
already handled. Consequences are gated on winning the claim, while the *delivery* is
always logged — that is what makes suppression visible rather than looking like a
webhook that never arrived.

**Outbound claim/commit.** Claim before the call, settle after. The distinction that
makes retries safe:

> **A provider that answered tells us the effect definitively did not happen** — retry
> freely. **Silence** — timeout, socket reset, or a crash between calling and recording
> — **is genuinely ambiguous**, so ask the provider by key rather than guess. Guessing
> either double-sends or drops.

Concurrency is arbitrated by the **work-queue lease**, not by the claim. The claim's
only job is recording what happened. Conflating those two roles produced a real bug
during the build, where a dispatcher deferred forever instead of retrying its own
previous attempt.

**Replay.** Not a feature. Because keys derive from stable inputs, a re-run recomputes
identical keys and every committed effect short-circuits. Replay safety is a
*consequence* of key derivation.

### The link everything hangs on

Derived-key idempotency only holds if `lead_id` is stable under redelivery. Intake is
therefore keyed on `source_event_key = hash(source, provider_event_id ?? canonical
payload)` with a unique index; a redelivery finds the existing mapping and reuses the
original `lead_id`. Get this wrong and every downstream key differs and every effect
fires twice.

**Inbound dedup and entity dedup are deliberately separate layers.** Idempotency
suppresses *the same event twice*; duplicate detection resolves *two events about one
person*. Edge cases 11 and 1 look alike and are not. Conflating them either drops a
real lead or double-processes a redelivery.

### Entity-level concurrency

Separate from the claim: the `lead` row carries a `version` column, and every pipeline
write is `WHERE lead_id = $1 AND version = $2`. Zero rows affected means another
workflow wrote while we were deciding, and **every dependent CTE in the same statement
produces nothing** — no partial application. Verified: replaying a decision against a
stale version updates nothing at all.

---

## 10. Logging and observability

`event_log` is append-only, enforced by a trigger that raises on UPDATE and DELETE. An
audit trail that can be edited is not one.

The design rule: **log decisions with their inputs, not messages.** "Routed to manual
review" is unreconstructible. This is not:

```
{decision: manual_review, rule: ai_rules_conflict, score: 32,
 band: unqualified, ai_label: high_potential, ai_confidence: 0.91,
 predicate_version: v1}
```

`lead_timeline` interleaves decisions with the external effects they caused, joining
`event_log` and `idempotency_claim`, so "what we decided" and "what we actually did to
a third party" are one query. It carries an insertion-order tiebreak because several
decisions are written by a single statement and share a timestamp — without it the
trail reads back alphabetically and appears to show the pipeline classifying before it
enriched.

`ops_summary` is the brief §3.J report: totals, per-disposition counts, duplicates
merged and in review, VIP and approvals pending, dead letters, queue depth, ambiguous
effects awaiting reconciliation, and SLA breaches. Deliberately a view rather than a
dashboard — it answers every question asked, and a dashboard is presentation work.

Worked example of both: `05_Test_Evidence/ops-summary-example.md`.
Reporting script: `node scripts/ops-report.mjs <lead_id>`.

---

## 11. Error handling and retry

**Classify before retrying.** 429/408/5xx/timeout/transport are retryable; other 4xx
and authentication failures are terminal and go straight to the dead-letter table.
Burning five attempts on a 401 is slow and useless, and the brief names missing
credentials as its own case.

**Backoff** is full jitter: `random(0, min(2s × 2^attempt, 15min))`, five attempts.
Full jitter over equal jitter because it decorrelates retry storms harder. A `Retry-After`
header, when the provider offers one, beats our own computation.

n8n's built-in `retryOnFail` is deliberately unused: it retries at a fixed short
interval inside the same execution, so it cannot express minutes-scale backoff and
loses all state if the execution dies. Retry lives in the queue instead, which means
retry behaviour is not visible on the canvas — worth knowing before a reviewer asks
where the retry configuration is.

**Dead-lettering.** Exhausted or terminal work lands in `dead_letter` with the payload
and the original idempotency key. `wf-50` catches anything that escapes in-flow
handling via n8n's Error Trigger, wired to every workflow by the build script rather
than by each generator, so a new workflow cannot forget to.

**Safe manual reprocessing** (`wf-51`) comes down to one rule:

> A claim that **succeeded** is never touched, so an effect that already happened
> cannot happen twice. A claim that **failed permanently** is cleared, because that
> effect provably did not happen and an operator replaying it is an explicit decision
> to try again.

Requeued work carries its original key, so anything already committed short-circuits.
Rows that are not replayable *work* — a corrupted CSV row, an unhandled crash — stay
open, because they need a human to correct the input, not a machine to try harder.

**Time-based work re-validates at dispatch, never at schedule time.** A follow-up
queued an hour ago is judged against consent, ownership and booking state as they are
*now*. This is what makes edge cases 9 and 10 correct rather than lucky, and it is why
follow-ups live in a table: an n8n `Wait` node cannot be cancelled or signalled from
outside, so a scheduled follow-up would be uncancellable and would not survive a
restart.

---

## 12. Human approval and manual review

Four checkpoints, all state machines in the database rather than waiting executions —
a table answers "how many approvals are pending?" in SQL and reuses the scheduler
already built.

| Checkpoint | Trigger | Held |
|---|---|---|
| VIP approval | score ≥ 90 or strategic account | Sales outreach only; the acknowledgement still sends |
| Duplicate review | dedup confidence 0.65–0.90 | CRM create and all outbound |
| AI/rules conflict | bands >1 apart, confidence ≥ 0.6 | Sales outreach and the follow-up sequence |
| Data completion | no reachable channel | All outbound |

Approval timeout is **risk appetite, not engineering**, so it is a setting:
`VIP_APPROVAL_ON_TIMEOUT` = `escalate` (default — fail closed, notify a second
approver) · `send` (fail open) · `hold`. An unrecognised value fails closed.

---

## 13. Testing approach

Three layers, each answering a different question.

**Unit tests** (`node --test 09_Lib/lib.test.mjs`) — 48 tests over the pure logic:
normalisation, key derivation, dedup scoring, lead scoring, routing, CSV parsing,
follow-up cadence, failure classification. Code nodes cannot be tested in place, so the
logic lives in `09_Lib` and is injected into workflows by `scripts/build-workflows.mjs`,
which has a `--check` mode that fails when a workflow carries a stale copy.

Two of these tests are worth pointing out. One verifies the bundled SHA-256 against
`node:crypto` across block-boundary lengths and unicode fuzz, because the Code node
sandbox has no `crypto` and the hash ships inside the workflow. Another asserts the
circumstantial dedup weights stay below the band gap, guarding an invariant that a
future weight edit would otherwise break silently.

**Harness self-test** (`node 07_Mock_Services/selftest.mjs`) — 28 assertions verifying
the mocks themselves: every fault mode fires, lookup-by-key works, the stage lattice
refuses regressions, the journal distinguishes delivered from replayed from lookup. If
these fail, any edge-case evidence built on them is worthless.

**Edge-case evidence** (`node 05_Test_Evidence/run-edge-cases.mjs`) — all 14 mandatory
cases, each resetting the database and mocks first so cases are independent. **14 of 14
pass.** Transcript in `05_Test_Evidence/RESULTS.md`.

Assertions are made against **external observations** wherever possible — the provider's
call journal, the CRM mock's record count — rather than against what the pipeline
reports about itself. A pipeline grading its own homework is not evidence.

Two cases need simulated elapsed time (a 30-minute SLA window, a compressed follow-up
cadence) rather than real waiting. Both are marked in the harness. `FOLLOWUP_TIME_SCALE`
compresses every follow-up interval uniformly; the sequence being demonstrated is
unchanged, only the clock.

---

## 14. Known limitations

Ordered by how much they would matter in production.

1. **Real Odoo has no Stripe-style idempotency keys.** Its XML-RPC/JSON-RPC API offers
   no `Idempotency-Key` header, and the mock implements one — so the demo is cleaner
   than production would be. The honest production design is unchanged in shape: the
   client-side claim plus a reconciliation *search* on an indexed custom field
   (`x_idempotency_key`) with a uniqueness constraint. Only the reconciliation read
   becomes more expensive. **This is the most significant mock-to-production
   divergence in the submission.**

2. **The mock enforces the stage lattice; real Odoo will not.** A mock stricter than
   production can hide bugs. Mitigated by implementing the guard client-side in
   `wf-21` as well — the 409 is an assertion aid, not the mechanism.

3. **Dedup candidate blocking is exact-match** on phone, email, name or company. A
   typo'd name with no other matching field is missed entirely. Production wants a
   trigram or phonetic blocking key; the scoring that follows is unchanged.

4. **Dedup thresholds are unfitted priors.** No labelled outcomes exist. Mitigated by
   storing every feature vector so they can be fitted later.

5. **Phone normalisation covers six dial plans** (AE, GB, US, DE, JP, EG) with a
   hand-rolled parser. Production wants libphonenumber-js, which knows about number
   types, carrier prefixes and the many places national number length varies.

6. **Postgres-as-queue is volume-bounded.** Correct and simple at hundreds/day; the
   one-minute tick becomes the bottleneck long before Postgres does.

7. **Tick granularity means the 30-minute SLA fires at 30–31 minutes.** Stated so it is
   not mistaken for a bug.

8. **Edge case 12's compensation is deliberately partial.** Already-delivered messages
   cannot be recalled; only future effects are cancelled.

9. **The mock providers share one process**, so they are not independent failure
   domains. The `reset` fault mode covers the transport-failure class; stopping the
   container is the heavier demonstration.

10. **Queue mode is not enabled by default.** The SQL is written for concurrent workers
    (`FOR UPDATE SKIP LOCKED`, optimistic concurrency) but the default stack runs a
    single n8n instance. Enabling it is a compose profile, not a redesign.

11. **Email is the same dispatcher with a `channel` field**, not a separate
    integration. The claim/commit and hold logic are channel-agnostic; a second
    integration would duplicate all of it to demonstrate nothing new.

12. **No authentication on the intake webhooks.** Production needs signature
    verification per source (Meta's `X-Hub-Signature-256`, a shared secret for the
    website form). The idempotency layer is unaffected either way.

### Next improvements, in the order I would do them

1. Webhook signature verification per source.
2. Trigram blocking for dedup candidates, and fit the thresholds once labelled merges
   exist.
3. libphonenumber-js in the Code nodes via a small custom n8n image.
4. Queue mode plus a second worker, to exercise the concurrency the SQL already assumes.
5. Grafana over `ops_summary`, and alerting on `claims_needing_reconciliation` — a
   non-zero, non-draining value there is the earliest signal that a provider is
   misbehaving.
