// Follow-up sequences, SLA and approval expiry are the same mechanism: do X at time
// T, revalidating state at T. An n8n Wait node cannot be cancelled or signalled from
// outside, so a scheduled follow-up would be uncancellable and would not survive a
// restart. The wait therefore lives in a table and the decision is made at dispatch.

// Qualified leads get chased quickly and briefly. Nurture leads get a long, sparse
// sequence.
export const SEQUENCES = {
  qualified: [
    { step: 1, after_minutes: 60,     slot: 'followup.1', note: 'same-day nudge' },
    { step: 2, after_minutes: 1440,   slot: 'followup.2', note: 'next-day follow-up' },
    { step: 3, after_minutes: 4320,   slot: 'followup.3', note: 'final attempt at 72h' },
  ],
  nurture: [
    { step: 1, after_minutes: 4320,   slot: 'followup.1', note: '3-day check-in' },
    { step: 2, after_minutes: 14400,  slot: 'followup.2', note: '10-day value touch' },
    { step: 3, after_minutes: 43200,  slot: 'followup.3', note: '30-day re-engage' },
  ],
};

// Demo compression. Real cadence is measured in hours and days, which no reviewer is
// going to sit through, so the scale factor shortens every interval uniformly without
// changing the sequence being demonstrated.
export function scaleMinutes(minutes, scale = 1) {
  const s = Number(scale);
  const factor = Number.isFinite(s) && s > 0 ? s : 1;
  return Math.max(1 / 60, minutes * factor);
}

export function nextStep({ disposition, currentStep = 0 }) {
  const seq = SEQUENCES[disposition];
  if (!seq) return null;
  return seq.find((s) => s.step === currentStep + 1) ?? null;
}

// Reasons a sequence stops for good. Checked at dispatch rather than at schedule
// time, because every one of these can become true while the work is still queued.
export function sequenceStopReason(lead, { booking = null } = {}) {
  if (!lead) return 'lead no longer exists';
  if (lead.consent_status === 'withdrawn' || lead.consent_status === 'denied') {
    return `consent ${lead.consent_status}`;
  }
  if (lead.dedup_status === 'merged_into') return 'lead merged into another record';
  if (booking || lead.status === 'meeting_booked') return 'meeting booked';
  if (lead.status === 'closed' || lead.status === 'won' || lead.status === 'lost') {
    return `lead ${lead.status}`;
  }
  if (lead.status === 'replied') return 'lead replied';
  if (lead.approval_state === 'rejected') return 'VIP rejected by manager';
  if (!['qualified', 'nurture'].includes(lead.disposition)) {
    return `disposition is ${lead.disposition}`;
  }
  return null;
}

// SLA is measured from assignment to the first logged sales action. Viewing a record
// is not an action; the definition is deliberately narrow, because a broad one makes
// the SLA unenforceable.
export function slaBreached(lead, { slaMinutes = 30, now = Date.now() } = {}) {
  if (lead.disposition !== 'qualified') return { breached: false, reason: 'not a qualified lead' };
  if (lead.last_sales_action_at) return { breached: false, reason: 'sales action already logged' };
  if (!lead.assigned_at) return { breached: false, reason: 'never assigned' };

  const elapsed = (now - new Date(lead.assigned_at).getTime()) / 60000;
  return {
    breached: elapsed >= slaMinutes,
    elapsed_minutes: Math.round(elapsed),
    threshold_minutes: slaMinutes,
    reason: elapsed >= slaMinutes
      ? `no sales action ${Math.round(elapsed)} minutes after assignment`
      : `within SLA (${Math.round(elapsed)} of ${slaMinutes} minutes)`,
  };
}

// What to do when a manager never answers a VIP approval. This is risk appetite, not
// engineering: sending unapproved risks an unwanted message to a strategic account,
// holding risks silence on the highest-value lead in the funnel. Configurable, and
// the default is the cautious one.
export const APPROVAL_TIMEOUT_POLICIES = ['escalate', 'send', 'hold'];

export function approvalTimeoutAction(policy = 'escalate') {
  switch (policy) {
    case 'send':
      return { action: 'release', reason: 'fail-open: timeout treated as approval' };
    case 'hold':
      return { action: 'hold', reason: 'fail-closed: outreach stays blocked until a human acts' };
    case 'escalate':
    default:
      return { action: 'escalate', reason: 'fail-closed with escalation to a second approver' };
  }
}
