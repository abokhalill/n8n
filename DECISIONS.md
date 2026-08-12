# Decision Log

Running record of every non-obvious choice. Format: what was chosen, what was rejected, why, and what would make me revisit.

Referenced edge cases are the numbered ones from brief section 4.

---

### D-001 — Durable state lives in Postgres, not in n8n

**Chose:** A Postgres database (`leadops`) holds all correctness-critical state: idempotency claims, the work queue, the audit log, lead records.

**Rejected:** `workflowStaticData` (n8n's built-in per-workflow key-value store).

**Why:** `$getWorkflowStaticData()` is flushed to disk only when an execution *finishes*, and concurrent executions each hold their own in-memory copy — last writer wins. There is no compare-and-set. An idempotency store without an atomic claim primitive is not an idempotency store. Postgres gives that for free via `INSERT ... ON CONFLICT DO NOTHING RETURNING`, where "zero rows returned" *is* the duplicate signal, in one round trip.

**Revisit if:** the reviewer's constraint is genuinely "pure n8n, no external state." Then the honest answer is that edge cases 7, 8 and 14 cannot be solved correctly, only approximately — and that trade-off should be stated rather than hidden.

---

### D-002 — An idempotency key names an *effect*, not an *attempt*

**Chose:** `v1:{effect_domain}:{entity_type}:{entity_id}:{occurrence}`, derived purely from stable inputs.

**Rejected:** Per-execution keys (`$execution.id`), random UUIDs minted at call time, attempt-counter suffixes.

**Why:** Two attempts at the same effect must collide; two distinct effects must never collide. Anything that varies between retries — timestamps, execution IDs, randomness — breaks the first property. Purity of derivation is what makes edge case 14 (manual re-run after partial success) fall out for free rather than needing its own mechanism.

**Revisit if:** an effect turns out not to have a stable natural occurrence identifier. So far every one does.

---

### D-003 — Outbound effects use claim/commit + reconciliation, not a seen-set

**Chose:** Write an `in_flight` claim *before* the external call, settle it to `succeeded`/`failed` after. A stale `in_flight` claim triggers a reconciliation read against the provider before any retry.

**Rejected:** Record-after-success (a seen-set).

**Why:** This is edge case 7 exactly. Record-after-call double-sends when the process dies between the call and the write. Record-before-call drops genuinely-failed calls. Neither is safe alone. Only a claim plus the ability to *ask the provider whether the effect landed* resolves the ambiguity — which is why the mock Odoo and mock WhatsApp must both support lookup-by-idempotency-key (see D-016).

**Revisit if:** a provider offers no lookup path. Then the fallback is at-most-once (never retry an ambiguous send) or at-least-once (accept possible duplicates), chosen per effect by which failure is worse. For WhatsApp, at-most-once is correct: a missing message beats a duplicate one.

---

### D-004 — Inbound event dedup and entity dedup are separate layers, deliberately

**Chose:** Two distinct mechanisms. `lead_source_event.source_event_key` (unique) suppresses *the same event delivered twice*. The duplicate-detection stage resolves *two different events about the same person*.

**Rejected:** One unified "is this a duplicate" step.

**Why:** Edge case 11 (booking webhook delivered twice) and edge case 1 (same person via WhatsApp and website) look alike and are not. The first must be a no-op; the second must produce two records that are then *linked*. Conflating them either drops a real lead or double-processes a redelivery.

---

### D-005 — Scheduled work lives in a table, not in a `Wait` node

**Chose:** A durable `work_queue` table plus a 1-minute cron dispatcher. Retries, follow-up steps, SLA checks and approval expiry are all rows in it.

**Rejected:** n8n `Wait` nodes holding an execution open for the follow-up interval.

**Why:** Edge case 10 requires cancelling a scheduled follow-up when the lead opts out. An in-flight `Wait` cannot be signalled or cancelled from outside the execution — there is no cancel token in n8n. The wait must therefore be data, not control flow. The payoff is that bounded-backoff retry, follow-up scheduling and SLA escalation collapse into one mechanism: *do X at time T, revalidating state at T*.

**Consequence worth naming:** state is read at **dispatch** time, not **schedule** time. That is also what makes edge case 9 (rep goes unavailable between assignment and follow-up) correct rather than lucky.

---

### D-006 — Queue leasing via `FOR UPDATE SKIP LOCKED`

**Chose:** Dispatcher claims a batch with `SELECT ... FOR UPDATE SKIP LOCKED` and sets a `lease_until`. Expired leases become claimable again.

**Rejected:** Naive `SELECT` then `UPDATE`; a single-worker assumption.

**Why:** n8n queue mode runs multiple workers, and cron triggers can overlap if a tick runs long. `SKIP LOCKED` makes concurrent dispatch safe without serialising. Lease expiry gives crash recovery: a worker that dies mid-item has the item redelivered.

**Closing the loop:** redelivery means the queue is deliberately *at-least-once*. Correctness comes from the idempotency layer beneath it, not from the queue. That is the thesis of the whole design.

---

### D-007 — Full-jitter exponential backoff, with retryable/terminal classification

**Chose:** `delay = random(0, min(base * 2^attempt, cap))`, base 2s, cap 15min, max 5 attempts. Errors are classified before scheduling: 429/408/5xx/timeout are retryable (429 honours `Retry-After` when present); other 4xx and missing-credential failures are terminal and go straight to the dead-letter table.

**Rejected:** n8n's built-in `retryOnFail`; equal jitter; retrying everything uniformly.

**Why:** n8n's node-level retry is a *fixed* short interval capped at a few seconds — it cannot express minutes-scale backoff, and it retries inside the same execution, so a crash loses the retry state entirely. Full jitter over equal jitter because it decorrelates retry storms more aggressively. Classifying before retrying matters because burning five attempts on a 401 is both useless and slow to surface — brief section I explicitly lists "missing credentials" as a case to handle, and the correct handling is *don't retry, alert*.

---

### D-008 — One outbound dispatcher, one Odoo writer

**Chose:** Exactly one workflow may call the messaging APIs (`wf-20`), exactly one may write to Odoo (`wf-21`). Everything else enqueues an intent.

**Rejected:** Letting each workflow call the API it needs.

**Why:** Idempotency enforcement that lives in N places is enforced in zero. A single choke point per side-effect class means the claim/commit protocol is implemented once and cannot be bypassed. It also gives one place to hold outbound during the VIP gate and the duplicate-review gate.

---

### D-009 — Odoo stages move through a monotonic lattice with an explicit rollback path

**Chose:** Stages carry a rank. The Odoo writer refuses a transition that lowers rank unless the request carries an explicit `rollback_reason`.

**Rejected:** Direct stage writes from each workflow.

**Why:** Brief section 3.E drives stage changes from qualification, follow-up, booking, manager rejection and SLA escalation. Without ordering protection, a slow scheduled writer can regress a lead from *Meeting Booked* back to *Contacted* — a lost update that is invisible until someone notices the funnel is wrong. Manager rejection (edge case 12) is a *legitimate* backwards move, so the guard needs a documented override rather than being absolute.

---

### D-010 — Merges are non-destructive

**Chose:** Merging links records (`duplicate_of`, `dedup_status = merged_into`) and marks the loser superseded. No record is deleted, no field is overwritten.

**Rejected:** Field-level merge into a survivor record with the loser deleted.

**Why:** Brief section 3.C says "do not blindly delete duplicates." Beyond compliance: a wrong merge is otherwise unrecoverable, because you have destroyed the evidence that two records existed. Non-destructive merge makes the *worst case of the auto-merge threshold* reversible, which is most of what justifies having an auto-merge threshold at all (see D-011).

---

### D-011 — Dedup tiers at 0.90 / 0.65, with contradiction demotion

**Chose:** ≥ 0.90 auto-merge; 0.65–0.90 manual review; < 0.65 distinct. A decisive identifier match can be *demoted* into the review band by contradicting evidence. Probable duplicates continue through enrichment and scoring but have their irreversible actions (CRM create, outbound messages) held.

**Rejected:** A single threshold; blocking the whole pipeline on review; treating a phone match as automatically decisive.

**Why:** The numbers are priors, not fitted values, and I will say so. What is defensible is the *shape*: a false merge is destructive and customer-visible, a false split is cheap and self-healing by a human later, so the boundary sits conservatively and the ambiguous band goes to a person. Contradiction demotion exists because a shared phone number is a real thing — office lines, family numbers — and a rule that merges on phone alone will eventually merge two different people. The governing principle for the hold: **gate the irreversible, not the reversible.**

**Revisit if:** real labelled outcomes exist. Every decision logs its full feature vector precisely so the thresholds can be fitted later rather than argued about.

---

### D-012 — AI classification is orthogonal to the deterministic score

**Chose:** The score is computed only from deterministic rules. The AI emits an independent label plus confidence. Disagreement is a *routing* signal, never a scoring input.

**Rejected:** Feeding AI output into the score as a weighted term.

**Why:** Brief 3.D says "a *separate* qualitative classification," and it is right. A score that depends on a non-deterministic model cannot be reproduced, cannot be explained after the fact, and cannot be regression-tested. Keeping them orthogonal also makes edge case 4 (malformed AI response) trivial: the pipeline degrades to score-only with `fallback_used: true` rather than blocking.

---

### D-013 — Human approvals are a database state machine, not a waiting execution

**Chose:** An `approval_request` row (pending → approved / rejected / expired), flipped by a callback workflow, expired by the scheduler.

**Rejected:** n8n's `Wait` node in "on webhook call" resume mode.

**Why:** Wait-on-webhook does persist across restarts, so this is closer than the timer case — but it holds an execution open indefinitely, makes "how many approvals are pending right now?" unanswerable without querying execution internals, and makes timeout handling awkward. A table answers the reporting question in SQL and reuses the scheduler already built for D-005.

---

### D-014 — Code nodes are pure functions; all I/O goes through native nodes

**Chose:** HTTP Request, Postgres, IF/Switch, Merge for anything with side effects. Code nodes only for pure transforms (normalisation, scoring, dedup feature extraction), with no network or database access inside them.

**Rejected:** Doing everything in a few large Code nodes.

**Why:** Two reasons, one for each audience. For a reviewer: the canvas *is* the flow chart, so the architecture is legible without reading code. For correctness: pure functions are unit-testable outside n8n, which is how the scoring and dedup logic gets regression coverage at all.

---

### D-015 — Optimistic concurrency on the lead record via a `version` column

**Chose:** `UPDATE lead SET ..., version = version + 1 WHERE lead_id = $1 AND version = $2`. Zero rows affected means someone else wrote; re-read and retry.

**Rejected:** Last-write-wins.

**Why:** The lead record is written by the pipeline, the scheduler, the booking handler and the approval handler, potentially concurrently. This is the entity-level CAS, distinct from the idempotency claim, which protects *external* effects. Both are needed; neither substitutes for the other.

---

### D-016 — Fault injection is deterministic and directive-driven, and the mock keeps a journal

**Chose:** Mocks expose a control plane to arm named faults scoped to a key ("fail the next 2 calls for enrichment key X with a timeout"), plus a per-request override header for one-shot tests. Every inbound call is recorded in a journal endpoint.

**Rejected:** Random/probabilistic failure injection.

**Why:** Edge case 3 says "times out twice, then succeeds" — that is a *scripted* sequence, and a reviewer must be able to reproduce it on demand. Random faults cannot be demonstrated, only waited for. The journal matters more: it is the test oracle. Edge case 8 is proven by asserting "the WhatsApp mock received exactly one send for this key across two workflow attempts" — an external observation, not the pipeline grading its own homework.

---

### D-017 — The scoring model is versioned

**Chose:** Every lead stores `score_model_version` alongside `score_breakdown`.

**Why:** A lead scored under v1 must remain explainable after v2 ships. Without this, the audit trail silently rots the moment the rules change, which is the first thing that happens in production.

---

### D-018 — Named scope cuts, stated in the README up front

**Chose:** Thin CSV path; operational summary as a SQL view rather than a dashboard; email as a `channel` field on the existing dispatcher rather than a second integration.

**Why:** Brief section 8 states plainly that a smaller stable solution beats a large unreliable one, and section 8's final bullet invites documenting what remains and how it would be finished. Uniform shallow coverage is the failure mode that instruction exists to prevent.

---

### D-019 — Resolving the VIP / Qualified collision in the brief's own rules

**Chose:** A transactional acknowledgement to the lead is not a sales action. Score ≥ 90 leads receive the immediate confirmation *and* have all sales outreach held pending manager approval.

**Why:** Brief section 5 says Qualified (≥ 70) gets "immediate confirmation" and VIP (≥ 90) requires approval "before an automated sales *message*." A score-95 lead satisfies both rules, and the brief does not resolve it. Withholding the acknowledgement would leave a high-value lead with silence, which is the worse outcome. The distinction is recorded here because it is an interpretation, not a derivation.

---

### D-020 — Compensation for post-hoc VIP rejection (edge case 12)

**Chose:** On rejection: roll the Odoo stage back with an explicit `rollback_reason`, cancel every pending outbound intent and scheduled follow-up for that lead, write an audit entry. Do **not** send a retraction message.

**Why:** The brief poses edge case 12 without saying what unwinds. Anything already delivered to the customer cannot be recalled, so the compensation covers only *future* effects. A retraction message would be a second unsolicited contact, which is worse than silence. This is the one place in the design where the correct behaviour is deliberately incomplete rollback, and it should be called out rather than smoothed over.
