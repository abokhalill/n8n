# Technical Design

---

## 1. Assumptions

Everything below rests on these. If one turns out to be wrong, the design that sits on
top of it needs revisiting rather than patching.

1. **Volume is hundreds of leads per day, not millions.** That's what justifies using
   Postgres as a queue and ticking once a minute. Somewhere above 100,000 a day the tick
   becomes the bottleneck and the design wants a real broker instead.
2. **A lead is a person, not a submission.** Two form fills from the same human are one
   lead with two source events. Duplicate detection exists because of this assumption.
3. **Consent is per-channel and can be withdrawn at any moment**, including while work
   is already scheduled. So consent gets read when work fires, never cached into it.
4. **Sales reps and their capacity live in our database**, seeded in `030_seed.sql`. A
   real deployment would read this from the CRM. Keeping it local is what makes workload
   routing and rep availability demonstrable without a live Odoo.
5. **"Sales action" means something a rep explicitly logged**, such as a recorded contact
   attempt or a stage advance they made by hand. Opening a record doesn't count. The
   brief never defines this, and the narrow reading is deliberate: a broad one makes the
   SLA impossible to enforce.
6. **"Materially conflict" means the AI label and the deterministic band are more than
   one band apart, with model confidence at or above 0.6.** Also undefined in the brief.
   Adjacent disagreement is noise, and treating it as conflict would route most of the
   funnel to a human.
7. **The booking provider issues a stable booking ID**, which is what booking events are
   keyed on.
8. **Several n8n workers might run at once.** Nothing here assumes single-threaded
   execution, which is why the SQL uses row locking and version checks throughout.
9. **Postgres owns the clock.** Every scheduling timestamp comes from `now()` inside the
   database rather than from a workflow, so clock skew between components is impossible
   by construction rather than unlikely in practice.
10. **The mocked providers cooperate on reconciliation** by supporting lookup by
    idempotency key. Section 12 records where real providers don't.

---

## 2. Architecture

Eleven n8n workflows over a Postgres state store, with every external system mocked.

```
sources ──▶ intake (×3) ──▶ work_queue ──▶ pipeline-core ──▶ work_queue
                                                                  │
                                          ┌───────────────────────┼──────────────────┐
                                          ▼                       ▼                  ▼
                                  outbound-dispatch         odoo-sync         scheduler-tick
                                   (only sender)         (only CRM writer)  (follow-up/SLA/expiry)
```

Diagrams live in `04_Architecture/`. Canvas screenshots are in `05_Test_Evidence/`.

### The one idea everything else follows from

**The queue is at-least-once by design.** Leases expire, workers die, and work gets
redelivered. That's not a weakness being tolerated; it's the deliberate shape. Every
reliability property in this document comes from the idempotency layer sitting
underneath, not from the transport being careful.

### Why the workflows are split where they are

Three boundaries decide what becomes a separate workflow:

- **Trust.** Each source has its own authentication and payload shape, so a malformed
  WhatsApp body can't take down website intake.
- **Retry.** n8n retries a whole execution, never a suffix of one. So anything that
  needs retrying independently has to be executable independently.
- **Time.** Anything that happens later can't share an execution with something
  happening now.

---

## 3. Workflows

| Workflow | Trigger | What it's responsible for |
|---|---|---|
| `wf-01/02/03-intake-*` | Webhook | Normalise, key, persist, enqueue, acknowledge |
| `wf-10-pipeline-core` | Cron 1m plus ops tick | Dedup, enrichment, scoring, AI classification, routing, assignment |
| `wf-20-outbound-dispatch` | Cron 1m plus ops tick | The only workflow that sends messages |
| `wf-21-odoo-sync` | Cron 1m plus ops tick | The only workflow that writes to Odoo |
| `wf-30-scheduler-tick` | Cron 1m plus ops tick | Follow-ups, SLA checks, approval expiry |
| `wf-40-booking-webhook` | Webhook | Booking events, keyed on the provider's booking id |
| `wf-41-approval-callback` | Webhook | VIP approve and reject, keyed on the approval token |
| `wf-50-error-handler` | Error Trigger | Unhandled failures land in the dead-letter table |
| `wf-51-dlq-reprocess` | Manual plus webhook | Safe operator replay |

Every consumer also exposes an `ops/tick/*` webhook so tests and demos don't have to
wait a minute per step. The cron schedule is what runs in production.

Two properties are worth calling out because a lot depends on them.

**Intake does nothing beyond normalising and enqueuing.** No enrichment, no scoring, no
messaging. That's precisely what lets two sources arriving together be reconciled once,
downstream, rather than racing each other in two webhook handlers.

**The pipeline performs no external writes at all.** Its only outbound calls are two
reads, for enrichment and classification. Everything with a side effect gets enqueued
for the dispatcher that owns it. That's what makes the whole pipeline safe to re-run.

---

## 4. Data schema

Ten tables, defined in `08_Database/migrations/010_schema.sql`. Two constraints do most
of the real work:

- **`lead_source_event.source_event_key UNIQUE`** suppresses duplicate inbound events.
  More importantly, it keeps `lead_id` stable when a webhook is redelivered, and every
  downstream idempotency key depends on that stability.
- **`idempotency_claim.key PRIMARY KEY`** is the atomic claim for outbound effects.

| Table | Purpose |
|---|---|
| `lead` | The canonical record. Its `version` column carries optimistic concurrency |
| `lead_source_event` | Raw payload archive and intake idempotency, in one place |
| `idempotency_claim` | Claim and commit ledger for every external effect |
| `work_queue` | Durable timer wheel for all deferred work |
| `dead_letter` | Terminal failures, with replay lineage |
| `duplicate_decision` | Every dedup verdict, with the full feature vector behind it |
| `sales_rep` | Capacity, service categories, regions, availability |
| `approval_request` | The VIP gate. Tokens come from `gen_random_uuid()` |
| `event_log` | Append-only audit, enforced by a trigger |
| `app_config` | Runtime values a SQL view needs, synced from `.env` by bootstrap |

There are four views: `ops_summary`, `lead_timeline`, `claims_needing_reconciliation`,
and `outbound_message`. That last one is a view over `idempotency_claim` rather than a
table of its own, because the send ledger and the idempotency ledger record the same
facts, and two copies of one fact eventually disagree.

**Raw values sit alongside normalised ones everywhere**, so `phone_raw` next to
`phone_e164` and `email_raw` next to `email_normalized`. Normalisation throws
information away, and when someone disputes a merge you need the bytes the customer
actually typed.

---

## 5. Business rules and scoring

Scoring is deterministic, versioned as `SCORE_MODEL_VERSION = 'v1'`, and fully
attributable. `score_breakdown` stores a `{rule_id, points, reason}` entry per rule and
reconciles exactly to the final score, cap included.

| Rule | Points | Basis |
|---|---:|---|
| `company_size` | 0 to 20 | Enriched headcount: 1000+ scores 20, 250+ scores 15, 50+ scores 10, 10+ scores 5 |
| `industry_fit` | 0 to 10 | Manufacturing, logistics and healthcare are the target industries |
| `service_interest` | 0 to 15 | Implementation 15, consulting 12, training 6, support 4 |
| `budget_band` | 0 to 20 | A stated budget is preferred. Company revenue is only a fallback proxy |
| `timeline` | 0 to 15 | Immediate 15, this quarter 10, six months 5, exploring 0 |
| `completeness` | 0 to 10 | Two points each for email, phone, company, a described need, country |
| `region_served` | 0 to 10 | The region is one we cover |
| `strategic_account` | 0 or 15 | Set by the enrichment flag |

The raw total is capped at 100, and the cap is itself an audited rule so points never
disappear without explanation.

**Bands:** 70 and above is qualified, 40 to 69 is nurture, below 40 is unqualified.
**VIP:** 90 and above, or the strategic account flag.
**SLA:** a qualified lead with no logged sales action 30 minutes after assignment.

### Two rules in the brief that contradict each other

The brief's own rule table collides in two places. Both needed a ruling, and both
rulings are interpretations rather than derivations, so they're recorded here.

**Qualified against VIP.** Section 5 says a score of 70 or more gets "immediate
confirmation", and 90 or more requires manager approval "before an automated sales
message". A lead scoring 95 satisfies both rules at once. The resolution is that **a
transactional acknowledgement is not a sales action**. The acknowledgement goes out
immediately; only the sales outreach waits for the manager. Withholding the
acknowledgement would leave the highest-value leads sitting in silence.

**Rejecting a VIP after qualification** (edge case 12) has no stated unwind at all. The
resolution is that compensation covers **future effects only**: cancel pending outbound
and follow-ups, roll the Odoo stage back with an explicit reason, and audit all of it.
**No retraction message is sent.** Anything already delivered can't be recalled, and a
second unsolicited contact is worse than silence.

### AI classification

The model stays orthogonal to the score, which is what section 3.D of the brief asks for
when it says "a *separate* qualitative classification". The model sees only
`free_text_need`. A score that depended on a non-deterministic model couldn't be
reproduced, explained after the fact, or regression tested.

Disagreement is a *routing* signal, never a scoring one. More than one band apart with
confidence at or above 0.6 sets `conflict_flag` and sends the lead to manual review
whatever its score. The predicate carries its own version alongside the score model.

The model is treated as an untrusted service returning untrusted bytes. Responses are
requested as **text rather than JSON**, so a malformed body is ours to inspect instead
of something that crashes a node. Empty, truncated and unparseable responses all degrade
to score-only with `fallback_used: true` and a specific reason recorded.

---

## 6. Duplicate detection

Features are derived independently, the weights are published, and every decision stores
its full vector so a merge can be re-argued later from what was actually seen.

**Decisive evidence** scores 0.95: normalised phone matching exactly, email matching
exactly, or the email dedup key matching.

**Identity evidence** tops out at 0.75:

| Signal | Weight |
|---|---|
| Email local part matches across different domains | 0.35 |
| Name similarity, Jaro-Winkler on the normalised name | 0.25 × similarity |
| Company matches | 0.15 |

**Circumstantial evidence** tops out at 0.20: submitted within 24 hours scores 0.10, and
arriving from a different source scores 0.10. Cross-source *raises* suspicion rather than
lowering it, because edge case 1 is precisely one person arriving through two channels.

> The circumstantial weights total 0.20, which is deliberately less than the 0.25 gap
> between the review and auto-merge thresholds. Timing and source can move a pair within
> a band, but they can never carry it into an automatic merge on their own. A unit test
> guards this invariant, so a future weight edit fails the build rather than quietly
> starting to merge people who merely arrived together.

**Tiers:** 0.90 and above merges automatically, 0.65 to 0.90 goes to a human, below 0.65
is treated as distinct.

**Contradiction demotion** pulls a decisive match back down into the review band when
other evidence disagrees: the same phone number, a different email, *and* low name
similarity. Shared office lines and family numbers are real, and a rule that merges on
phone alone will eventually merge two different people.

### On the thresholds

They're priors, not fitted values, and nothing here pretends otherwise. What is
defensible is the shape of the decision rather than the numbers in it.

A false merge is destructive and visible to the customer. A false split is cheap and
heals itself when a human merges the records later. Those costs are wildly asymmetric,
so the boundary sits conservatively, the ambiguous band goes to a person, and merges are
non-destructive: records are linked and superseded, never deleted or overwritten. Even a
wrong auto-merge stays reversible.

Every decision stores its feature vector, which means the thresholds can eventually be
fitted from real outcomes instead of argued about. The strongest available claim isn't
"0.90 is correct", it's "the system is instrumented to find out what correct is".

**One principle governs every hold: gate the irreversible, not the reversible.** A
probable duplicate keeps getting enriched and scored, because both can be redone. Its
CRM record and its outbound messages wait for a human, because neither can be undone.

Candidate blocking is exact-match on phone, email, name or company. Section 12 covers
what that misses.

---

## 7. External integrations

All five providers are mocked in `07_Mock_Services`: one process, namespaced routes, a
fault control plane, and a call journal.

| Provider | Notes |
|---|---|
| Odoo | Honours `Idempotency-Key`, exposes lookup by key, enforces the stage lattice |
| WhatsApp | Honours `Idempotency-Key`, exposes lookup by key |
| Enrichment | Firmographics by email domain. A miss returns `200 {found:false}`, not an error |
| LLM | Deterministic keyword classifier |
| Booking | Can deliver the same webhook any number of times |

**Fault injection is deterministic and never random.** Edge case 3 describes a scripted
sequence, "times out twice then succeeds", and a reviewer has to be able to reproduce
that on demand rather than wait around for it. There are eight modes: `timeout`, `slow`,
`status`, `reset`, `malformed`, `empty`, `respond` and `drop_response`.

Two of those deserve explanation.

**`reset`** destroys the socket, producing `ECONNRESET`. That's the "service is down"
error class, and it travels a completely different code path in the client than any HTTP
status code does.

**`drop_response`** lets the request handler run and mutate state, then kills the socket
before the client learns anything. It's the only honest way to reproduce edge case 7,
because `timeout` short-circuits before the handler runs and so the record never gets
created at all. Without this mode, any evidence for edge case 7 would be theatre.

**The journal is the test oracle.** Every inbound call is recorded and classified as
`delivered`, `replayed`, `lookup` or `rejected`. Edge case 8 is proven by asserting that
the provider saw two calls and exactly one delivery, which is an observation from
outside the system rather than the pipeline reporting on itself.

### Odoo stage semantics

Stages carry a rank: new 10, contacted 20, qualified 30, proposition 40, meeting booked
50, won and lost both 100. A transition that would lower the rank is refused unless it
carries an explicit `rollback_reason`. Setting a lead to the stage it's already in is a
no-op rather than a conflict, which keeps stage writes safely repeatable.

This matters because stage changes come from qualification, follow-up, booking, manager
rejection and SLA escalation, all at different times. Without ordering protection, a
slow writer can drag a lead from *Meeting Booked* back to *Contacted*, and nobody
notices until the funnel numbers look wrong.

---

## 8. Authentication and secrets

- No real credential appears in this repository. `.env.example` contains placeholders,
  `.env` is git-ignored, and it was never committed.
- Endpoints and tokens reach workflows as `$env.*`, so nothing is baked into an exported
  workflow. Moving an integration to production is a base URL change.
- The n8n Postgres credential is assembled from `.env` at bootstrap into a temporary
  file, imported, then deleted from both host and container. It's stored encrypted under
  `N8N_ENCRYPTION_KEY`, verified by reading the ciphertext out of the database.
- One value has to be genuinely unguessable, the VIP approval callback token, because it
  travels in a URL. Postgres generates it with `gen_random_uuid()`, because the Code node
  sandbox has no cryptographic random source. Secret material gets generated where a
  CSPRNG actually exists.

**Not implemented:** webhook signature verification. See section 12.

---

## 9. Idempotency

This is the core of the system, so it's worth reading even if you skip everything else.

### The key

```
v1:{effect_domain}:{entity_type}:{entity_id}:{occurrence}
```

Every key is derived purely from stable inputs. Never an execution id, never a timestamp,
never a random value, never an attempt counter. **A key names an effect, not an
attempt.** Two tries at the same effect collide by construction; two genuinely different
effects never do. A key part containing the separator is rejected outright rather than
silently mangled.

| Effect | What "occurrence" means |
|---|---|
| `odoo.lead.create` | Constant. A lead is created once |
| `msg.send` | The template slot, such as `welcome` or `followup.2` |
| `odoo.stage.set` | The target stage, which makes the write naturally repeatable |
| `booking.apply` | The **provider's** booking id, not our receipt of it |
| `approval.decide` | The approval token |

### The same key, used three ways

**Suppressing inbound events.** `INSERT ... ON CONFLICT DO NOTHING RETURNING`, where
zero rows returned means this event was already handled. Consequences are gated on
winning the claim, while the *delivery itself* is always logged. That distinction is what
makes suppression visible in the audit trail instead of looking like a webhook that never
turned up.

**Claiming outbound effects.** The claim is written before the call and settled after.
The distinction that makes retrying safe:

> **A provider that answered** tells us the effect definitively did not happen, so
> retrying is safe. **Silence**, whether a timeout, a socket reset, or a crash between
> calling and recording, is genuinely ambiguous. So we ask the provider by key rather
> than guess, because guessing either double-sends or drops.

Concurrency is arbitrated by the **work-queue lease**, not by the claim. The claim's only
job is recording what happened. Conflating those two roles produced a real bug during the
build, where a dispatcher deferred forever instead of retrying its own previous attempt.

**Replaying work.** Replay isn't a feature. Because keys derive from stable inputs, a
re-run recomputes identical keys and every committed effect short-circuits on its own.
Replay safety is a consequence of how keys are built.

### The link everything hangs on

Derived-key idempotency only works if `lead_id` stays stable when a webhook is
redelivered. If a redelivery minted a fresh id, every downstream key would differ and
every effect would fire twice.

So intake is keyed on `source_event_key = hash(source, provider_event_id ?? payload)`
with a unique index behind it. A redelivery finds the existing mapping and reuses the
original `lead_id`. This is the single point where getting it wrong silently defeats
everything downstream.

**Inbound dedup and entity dedup are deliberately separate layers.** Idempotency
suppresses *the same event arriving twice*. Duplicate detection resolves *two different
events about one person*. Edge cases 11 and 1 look similar and are not, and conflating
them either drops a real lead or double-processes a redelivery.

### Entity-level concurrency

Separate from the claim, the `lead` row carries a `version` column, and every pipeline
write is guarded by `WHERE lead_id = $1 AND version = $2`. Zero rows affected means
another workflow wrote while we were deciding, and because every dependent CTE lives in
the same statement, all of them produce nothing too. There's no partial application to
clean up: either the whole decision lands or none of it does.

---

## 10. Observability, errors and human checkpoints

### Logging

`event_log` is append-only, enforced by a trigger that raises on UPDATE and DELETE. An
audit trail that can be edited isn't one.

The rule that makes it useful: **log decisions along with their inputs, not messages**.
"Routed to manual review" can't be reconstructed. This can:

```
{decision: manual_review, rule: ai_rules_conflict, score: 32,
 band: unqualified, ai_label: high_potential, ai_confidence: 0.91,
 predicate_version: v1}
```

`lead_timeline` interleaves decisions with the external effects they caused, so what we
decided and what we actually did to a third party read as one sequence. It carries an
insertion-order tiebreak, because several decisions are written by a single statement and
share a timestamp. Without that, the trail sorts alphabetically and appears to show the
pipeline classifying a lead before it enriched it.

`ops_summary` is the operational report the brief asks for. Both views are visible in the
operator console and through `scripts/ops-report.mjs`.

### Retry

**Classify before retrying.** 429, 408, 5xx, timeouts and transport errors are
retryable. Other 4xx responses and authentication failures are terminal and go straight
to the dead-letter table. Burning five attempts on a 401 is slow and pointless, and the
brief calls out missing credentials as its own case.

Backoff is full jitter, `random(0, min(2s × 2^attempt, 15min))`, over five attempts.
Full jitter rather than equal jitter because it decorrelates retry storms more
aggressively. At five attempts the sequence tops out near 64 seconds, so the cap only
starts to matter at higher attempt counts. When a provider sends `Retry-After`, that
beats our own calculation.

n8n's built-in `retryOnFail` is deliberately unused. It retries at a fixed short interval
inside the same execution, so it can't express minutes-scale backoff, and it loses all
state if the execution dies. Retry lives in the queue instead, which does mean retry
behaviour isn't visible on the canvas. Worth knowing before someone asks where the retry
configuration went.

### Dead-lettering and replay

Exhausted or terminal work lands in `dead_letter` with its payload and original
idempotency key. `wf-50` catches anything that escapes in-flow handling through n8n's
Error Trigger, wired up by the build script rather than by hand so a new workflow can't
forget to.

Safe replay comes down to a single rule:

> A claim that **succeeded** is never touched, so an effect that already happened can't
> happen twice. A claim that **failed permanently** is cleared, because that effect
> provably did not happen and an operator replaying it is an explicit decision to try
> again.

Requeued work carries its original key, so anything already committed short-circuits.
Rows that aren't replayable work, like a corrupted CSV row or an unhandled crash, stay
open. They need a human to fix the input, not a machine to try harder.

### Time and human checkpoints

**Scheduled work re-validates when it fires, never when it was scheduled.** This is why
follow-ups live in a table: an n8n `Wait` node can't be cancelled or signalled from
outside, so a scheduled follow-up would be uncancellable and wouldn't survive a restart.

| Checkpoint | What triggers it | What gets held |
|---|---|---|
| VIP approval | Score 90+, or a strategic account | Sales outreach only |
| Duplicate review | Dedup confidence 0.65 to 0.90 | CRM record and all outbound |
| AI and rules conflict | Bands more than 1 apart, confidence 0.6+ | Sales outreach and follow-ups |
| Data completion | No reachable channel | All outbound |

All four are database state machines rather than waiting executions. A table can answer
"how many approvals are pending right now?" in SQL, and it reuses the scheduler that
already exists. All four are actionable in the operator console.

Approval timeout is risk appetite rather than engineering, so it's configurable:
`VIP_APPROVAL_ON_TIMEOUT` accepts `escalate` (the default, failing closed and notifying a
second approver), `send`, or `hold`. An unrecognised value fails closed.

**The SLA clock pauses while a VIP lead is gated.** The rep is blocked from acting by our
own gate, so measuring them against an SLA would escalate a breach the system itself
caused. Once approval lands, the window runs from whichever of assignment or approval
came later, so a rep who waited 40 minutes on a manager still gets their full window.

---

## 11. Testing

Three layers, each answering a different question.

| Layer | Command | What it covers |
|---|---|---|
| Unit | `node --test 09_Lib/lib.test.mjs` | 52 tests over the pure logic |
| Harness | `node 07_Mock_Services/selftest.mjs` | 28 assertions that the mocks fail correctly |
| End to end | `node 05_Test_Evidence/run-edge-cases.mjs` | 14 mandatory cases plus interaction regressions, 16 of 16 |

Code nodes can't be unit tested where they live, so the logic sits in `09_Lib` and gets
injected into workflows by `scripts/build-workflows.mjs`. Its `--check` mode fails the
build when a workflow is carrying a stale copy.

Two of the unit tests are worth pointing at. One verifies the bundled SHA-256 against
`node:crypto` across block-boundary lengths and unicode fuzz, because the Code node
sandbox has no `crypto` and the hash ships inside the workflow. Another asserts the
circumstantial dedup weights stay below the band gap, guarding an invariant a future
weight edit would otherwise break silently.

**Assertions are made against external observations wherever possible**: the provider's
own call journal, the CRM mock's record count. A pipeline grading its own homework isn't
evidence.

Two cases need simulated elapsed time rather than real waiting, for a 30-minute SLA
window and a compressed follow-up cadence. Both are marked in the harness.

The documented path is verified from cold: `docker compose down -v`, `cp .env.example
.env`, `up --build`, one bootstrap run, 15 of 15 passing, using the placeholder
credentials a reviewer actually gets rather than developer-generated ones.

---

## 12. Known limitations

Ordered by how much they'd matter in production.

1. **Real Odoo has no idempotency-key header.** Its XML-RPC and JSON-RPC APIs offer
   nothing equivalent, and our mock implements one, so the demo is cleaner than
   production would be. The production design keeps the same shape: a client-side claim
   plus a reconciliation *search* on an indexed `x_idempotency_key` field with a
   uniqueness constraint. Only the reconciliation read gets more expensive. **This is the
   largest gap between what's demonstrated and what would ship.**
2. **The mock enforces the stage lattice and real Odoo won't.** A mock stricter than
   production can hide bugs, so the guard is also implemented client-side in `wf-21`. The
   409 response is an assertion aid, not the mechanism.
3. **Dedup candidate blocking is exact-match** on phone, email, name or company. A typo'd
   name with nothing else matching is missed entirely. Production wants trigram or
   phonetic blocking, and the scoring that follows would be unchanged.
4. **Case 8's proof is only as strong as the mock.** "Exactly one delivery" is asserted
   against a provider that records synchronously. A mock that modelled async ingestion,
   2xx followed by rollback, or partial writes would be a harder test, and those are the
   conditions under which the reconciliation guard above becomes unsound.
5. **Dedup thresholds are unfitted priors**, because no labelled outcomes exist yet.
   Mitigated by storing every feature vector so they can be fitted later.
5. **Phone normalisation covers six dial plans** with a hand-rolled parser. Production
   wants libphonenumber-js, which knows about number types, carrier prefixes, and the
   many places where national number length varies.
6. **No webhook signature verification.** Production needs it per source, using Meta's
   `X-Hub-Signature-256` and a shared secret for the website form. The idempotency layer
   is unaffected either way.
7. **Postgres as a queue is volume-bounded.** It's correct and simple at hundreds of
   leads a day, and the one-minute tick becomes the bottleneck long before Postgres does.
8. **The 30-minute SLA fires somewhere between 30 and 31 minutes** because of tick
   granularity. Stated so it isn't mistaken for a bug. Related: the threshold is authored
   in `.env`, but a SQL view can't read that, so bootstrap syncs it into `app_config`.
   Changing `SLA_MINUTES` means re-running bootstrap, or the summary and the engine will
   disagree.
9. **Edge case 12's compensation is deliberately partial.** Already-delivered messages
   can't be recalled, so only future effects are cancelled.
10. **The mock providers share one process**, so they aren't independent failure domains.
    The `reset` fault mode covers the transport-failure class, and stopping the container
    is the heavier demonstration.
11. **Queue mode is off by default.** The SQL is written for concurrent workers, using
    `FOR UPDATE SKIP LOCKED` and optimistic concurrency, but the default stack runs a
    single n8n instance. Turning it on is a compose profile.
12. **Email is a `channel` field** on the existing dispatcher rather than a separate
    integration. The claim, commit and hold logic are all channel-agnostic, so a second
    integration would duplicate everything to demonstrate nothing new.
13. **"Not found" is not proof that an effect never happened.** Reconciliation treats a
    negative lookup as permission to send again. Against providers with asynchronous
    ingestion, replication lag, or accept-then-materialise semantics, that lookup can
    report absence for an effect that did land, turning a timeout into a duplicate. The
    guard is only sound where the provider offers read-after-write on the lookup, and
    the mocks do. Production needs a per-provider ingestion window before the negative
    verdict is trusted.
14. **Not every provider supports lookup by key.** WhatsApp Cloud API does, SMTP email
    does not. Where a provider offers no lookup, the ambiguous case has only two sound
    resolutions: at-most-once, dead-lettering on timeout, or accepted at-least-once.
    Today the dispatcher assumes lookup is available, so email would need a
    `supports_lookup_by_key` capability flag and a documented fallback before it ships.
15. **Enrichment and classification sit outside the claim boundary.** `wf-10` makes two
    provider calls but takes no claim over them, because neither mutates anything. The
    cost is that a redelivered pipeline item re-runs both. Enrichment is a pure read so
    that is merely wasteful, but a non-deterministic model could return a different
    label on the second run and route the lead differently. The mock classifier is
    deterministic, so this never shows in testing. Memoising responses per lead and step,
    or extending the claim to cover the classifier, would remove it.
16. **The in-flight guard uses a presumption window, not a renewed lease.** A claim is
    treated as in flight until `stale_after`, set from the HTTP timeout when the call
    starts. There is no heartbeat extending it, so a worker paused longer than the window
    while genuinely mid-call could still have its effect re-attempted by another worker.
    The window is 120 seconds against a 5 second HTTP timeout, so the gap is large, but
    it is a presumption rather than a guarantee.
17. **Single-fault testing was the harness's blind spot.** Two bugs lived in the seams
    between individually-correct subsystems: the SLA clock running while the VIP gate
    blocked the rep, and a booking failing to close a pending approval. Both were found
    by review rather than by the suite, as was a third: every failure test used an HTTP
    error response, which *answers*, so the pure-timeout path where reconciliation has to
    reach and record a verdict went untested and was silently losing messages.
    Interaction regressions now run alongside the brief's fourteen cases, but plenty of
    combinations remain untested.

### What I'd do next, in order

1. Webhook signature verification per source.
2. More combinatorial scenarios: duplicate against booking, opt-out against retry, merge
   against approval. Given the hit rate so far, at least one should yield something.
3. Trigram blocking for dedup candidates, then fit the thresholds once labelled merges
   exist.
4. libphonenumber-js through a small custom n8n image.
5. Queue mode with a second worker, to exercise the concurrency the SQL already assumes.
6. Alerting on `claims_needing_reconciliation`. A value there that isn't draining is the
   earliest signal that a provider is misbehaving.
