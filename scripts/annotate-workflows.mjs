#!/usr/bin/env node
// Adds sticky notes to the n8n canvases.
//
// A canvas here is five or six nodes in a line. The reasoning lives inside Code
// nodes and SQL that nobody opens, so without annotation each workflow reads as
// trivial. These notes say what the section does and which edge case forced it.
//
//   node scripts/annotate-workflows.mjs
//
// Idempotent: existing notes are replaced, so re-running after a rebuild is safe.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WF = join(dirname(fileURLToPath(import.meta.url)), '..', '02_Workflows');

// n8n sticky colour indexes: 3 grey, 4 blue, 5 green, 6 amber, 7 red.
const NOTES = {
  'wf01intakeweb001': [
    [-260, -300, 700, 200, 4, `## Intake: acknowledge fast, process never
This workflow normalises the payload, derives two keys, persists, enqueues and returns. It deliberately does **no** enrichment, scoring or messaging.

That restraint is what lets the same person arriving from two sources be reconciled **once, downstream**, instead of two webhook handlers racing each other.`],
    [-30, 200, 460, 210, 6, `### The key everything depends on
\`source_event_key = hash(source, provider event id ?? payload)\` has a UNIQUE index behind it.

A redelivered webhook finds the existing row and reuses the **original lead_id**. Every downstream idempotency key is derived from that id, so if it changed on redelivery, every effect would fire twice.`],
    [200, 200, 520, 210, 5, `### One statement does all of it
Claim the event, create the lead, enqueue the pipeline and write the audit row, atomically.

\`ON CONFLICT DO NOTHING\` is what turns a duplicate delivery into a no-op. The caller gets the original lead_id back with HTTP 200 instead of 202, so a retrying client converges rather than piling up records.`],
  ],
  'wf02intakewa0001': [
    [-260, -300, 700, 190, 4, `## WhatsApp intake
Same shape as the website intake, different field names.

The one real difference: WhatsApp gives every message a stable \`message_id\`, so redelivery is detected on the **provider's own identifier** rather than on a content hash. When a provider offers you an id, take it.`],
  ],
  'wf03intakecsv001': [
    [-480, -320, 760, 210, 4, `## CSV import: a batch is not atomic
**Edge case 13.** Each row is parsed, validated and keyed on its own, so one corrupt row gets quarantined rather than failing the whole import.

Rows are keyed on their own content, which means re-importing the same file is a no-op instead of a second copy of every lead.`],
    [180, 250, 520, 190, 6, `### Quarantine, don't discard
Bad rows keep their original text and line number in \`dead_letter\`, so a human can correct and resubmit them.

They carry an idempotency key too. Re-importing the same broken file shouldn't queue the same problem for someone twice.`],
  ],
  'wf10pipelinecore': [
    [-700, -340, 900, 220, 4, `## The pipeline: every decision, no side effects
Dedup, enrichment, scoring, AI classification, routing and assignment all happen here.

**This workflow performs no external writes.** Its only outbound calls are two reads. Everything with a side effect is *enqueued* for the dispatcher that owns it, and that is exactly what makes the whole pipeline safe to re-run (**edge case 14**).`],
    [200, 200, 480, 230, 6, `### The AI is an untrusted service
Responses are requested as **text, not JSON**, so a malformed body is ours to inspect rather than something that crashes the node.

Empty, truncated and unparseable replies all degrade to score-only with a stated reason (**edge case 4**). The model never feeds the score. It produces an independent label, and disagreement is a *routing* signal (**edge case 5**).`],
    [700, -340, 460, 220, 5, `### One statement commits everything
The lead update, dedup decisions, audit rows, approval request, downstream queue items and work completion all land together.

The \`version\` predicate is the compare-and-set. If another workflow wrote this lead while we were deciding, **zero rows update and every dependent CTE produces nothing**. There is no partial application to clean up.`],
    [-260, 200, 460, 210, 3, `### Retry lives in the queue
A retryable enrichment failure hands the item back with full-jitter backoff (**edge case 3**).

Once the attempts are spent, the lead proceeds degraded. A provider that is down must not hold a lead hostage forever.`],
  ],
  'wf20outbounddisp': [
    [-700, -330, 880, 210, 4, `## The only workflow that sends messages
One enforcement point is the whole point. A protocol implemented in five workflows is enforced in none of them.

Claim, call, commit. The claim is written **before** the call, so a crash in between is recoverable rather than ambiguous forever.`],
    [-220, 200, 560, 260, 6, `### The distinction that makes retries safe
**A provider that answered** tells us the effect definitively did not happen, so retry freely.

**Silence**, whether a timeout, a socket reset or a crash mid-call, is genuinely ambiguous. So we ask the provider by key rather than guess, because guessing either double-sends or drops (**edge cases 7 and 8**).

State is re-read here too: an opt-out that arrived after this work was queued gets caught now (**edge case 10**).`],
    [380, 200, 420, 180, 5, `### Two independent layers
The idempotency key travels as a request header as well, so the provider dedupes alongside us.

Belt and braces: our claim record, and the provider's own idempotency.`],
  ],
  'wf21odoosync0001': [
    [-700, -330, 880, 210, 4, `## The only workflow that writes to the CRM
It shares the exact same two SQL statements as the outbound dispatcher, because the protocol is identical and implementing it twice is how two copies drift apart.`],
    [-220, 200, 620, 250, 6, `### The stage lattice
Stages carry a rank. A transition that would lower it is **refused** unless it carries an explicit \`rollback_reason\`.

Stage changes arrive from qualification, follow-up, booking, manager rejection and SLA escalation, all at different times. Without ordering protection, a slow writer drags a lead from *Meeting Booked* back to *Contacted*, and nobody notices until the funnel numbers look wrong.

Re-setting the stage a lead is already in is a no-op rather than a conflict, which keeps stage writes safely repeatable.`],
  ],
  'wf30schedulertick': [
    [-700, -350, 900, 240, 4, `## One dispatcher for everything time-based
Follow-ups, SLA checks and approval expiry are the same problem wearing three hats: **do X at time T, revalidating state at T.**

They live in a table rather than a Wait node because an n8n \`Wait\` cannot be cancelled or signalled from outside. A scheduled follow-up built that way would be uncancellable and wouldn't survive a restart.`],
    [-200, 190, 640, 270, 6, `### Nothing scheduled is trusted to still be right
The lead is re-read **at dispatch**, never taken from whatever was true when the work was queued.

- Opt-out after scheduling stops the sequence (**edge case 10**)
- An owner who went unavailable triggers escalation and reassignment, with a fresh clock (**edge case 9**)
- A VIP still awaiting approval **pauses** the SLA clock, because the rep is blocked from acting by our own gate. Measuring them would escalate a breach the system itself caused.`],
  ],
  'wf40bookinghook0': [
    [-480, -320, 800, 230, 4, `## Booking: keyed on the provider's id
**Edge case 11.** The claim is keyed on the booking id the provider issued, never on our receipt of it, so a webhook delivered twice applies once.

Consequences are gated on winning the claim, while the **delivery itself is always logged**. That's what makes suppression visible in the audit trail, rather than looking like a webhook that never arrived.`],
    [40, 220, 480, 210, 5, `### A booking ends more than the marketing
Pending follow-ups, SLA checks and the VIP approval timer are all cancelled, the funnel advances to *meeting_booked*, and the assigned rep is notified. Each of those carries its own idempotency key.

The approval gate becomes *superseded* rather than expired. Nobody failed to answer it; it simply stopped being a question.`],
  ],
  'wf41approvalcb00': [
    [-480, -330, 820, 230, 4, `## The VIP gate
**Edge case 12.** Keyed on the approval token, so a manager clicking twice still decides once.

This resolves a collision in the brief's own rules: a lead scoring 95 is both *Qualified*, which promises immediate confirmation, and *VIP*, which requires approval before outbound. A transactional acknowledgement is **not** a sales action, so the acknowledgement sends and only the outreach waits.`],
    [40, 220, 560, 230, 7, `### Rejection compensates forward only
Cancel pending outbound and follow-ups, roll the funnel back with an explicit reason, and audit all of it.

**No retraction message is sent.** Anything already delivered cannot be recalled, and a second unsolicited contact is worse than silence. This is deliberately incomplete rollback, and it's called out rather than smoothed over.`],
  ],
  'wf50errorhandler': [
    [-300, -280, 700, 210, 7, `## The net under the net
Every workflow routes unhandled failures here, wired up by the build script rather than by hand so a new workflow can't forget to.

In-flow failures are already classified and retried by the dispatchers. This catches only what nobody anticipated, which is why it records no idempotency key and is never deduped away.`],
  ],
  'wf51dlqreprocess': [
    [-520, -300, 820, 240, 5, `## Safe manual replay
**Edge case 14.** One rule makes it safe:

A claim that **succeeded** is never touched, so an effect that already happened cannot happen twice. A claim that **failed permanently** is cleared, because that effect provably did not happen and an operator replaying it is an explicit decision to try again.

Requeued work carries its original key, so anything already committed short-circuits on its own. Rows that aren't replayable work, like a corrupt CSV row or an unhandled crash, stay open for a human.`],
  ],
};

let touched = 0;
for (const file of readdirSync(WF).filter((f) => f.endsWith('.json'))) {
  const path = join(WF, file);
  const wf = JSON.parse(readFileSync(path, 'utf8'));
  const notes = NOTES[wf.id];
  if (!notes) { console.log(`  no notes defined for ${wf.name}`); continue; }

  wf.nodes = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
  notes.forEach(([x, y, width, minHeight, color, content], i) => {
    // Sized from the content rather than by hand. A clipped note is worse than no
    // note, because it looks like the explanation ran out halfway.
    const perLine = Math.max(24, Math.floor(width / 7.6));
    const lines = content.split('\n').reduce((n, line) =>
      n + Math.max(1, Math.ceil(line.length / perLine)), 0);
    const blanks = content.split('\n').filter((l) => l.trim() === '').length;
    const height = Math.max(minHeight, 56 + lines * 21 + blanks * 6);

    wf.nodes.push({
      parameters: { content, height, width, color },
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [x, y],
      // Well-formed UUID shape, derived so re-running produces identical ids.
      id: `${'a'.repeat(8)}-${'b'.repeat(4)}-4${'c'.repeat(3)}-8${'d'.repeat(3)}-${wf.id.slice(0, 8)}${String(i).padStart(4, '0')}`,
      name: `Note ${i + 1}`,
    });
  });

  writeFileSync(path, JSON.stringify(wf, null, 2) + '\n');
  console.log(`  ${wf.name}: ${notes.length} note(s)`);
  touched++;
}
console.log(`\nannotated ${touched} workflow(s)`);
