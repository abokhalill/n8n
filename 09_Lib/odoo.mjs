// Funnel stages, ranked. The rank is what lets a single writer refuse to move a
// lead backwards: stage changes are driven from qualification, follow-up, booking,
// manager rejection and SLA escalation, and without ordering protection a slow
// writer can regress a lead that has already progressed.
//
// This guard also lives in the mock, but that is an assertion aid. Real Odoo will
// happily write whatever stage you send it, so the guard has to be here.

export const STAGE_RANK = {
  new: 10,
  contacted: 20,
  qualified: 30,
  proposition: 40,
  meeting_booked: 50,
  won: 100,
  lost: 100,
};

const DISPOSITION_STAGE = {
  data_completion: 'new',
  manual_review: 'contacted',
  nurture: 'contacted',
  qualified: 'qualified',
  unqualified: 'lost',
  merged: null,        // the master carries the funnel; the loser has no stage of its own
};

export function stageForDisposition(disposition) {
  return DISPOSITION_STAGE[disposition] ?? null;
}

export function rankOf(stage) {
  return STAGE_RANK[stage] ?? null;
}

// Returns what the writer should do, and why, rather than a bare boolean — the
// reason ends up in the audit trail.
export function planStageTransition({ current, target, rollbackReason = null }) {
  if (!target) return { action: 'skip', reason: 'no stage implied by this disposition' };

  const targetRank = rankOf(target);
  if (targetRank === null) return { action: 'reject', reason: `unknown stage "${target}"` };

  if (!current) return { action: 'set', reason: `initial stage ${target}`, rank: targetRank };
  if (current === target) return { action: 'skip', reason: `already in ${target}` };

  const currentRank = rankOf(current) ?? 0;
  if (targetRank > currentRank) {
    return { action: 'set', reason: `advance ${current} -> ${target}`, rank: targetRank };
  }

  if (rollbackReason) {
    return { action: 'rollback', reason: `deliberate rollback ${current} -> ${target}: ${rollbackReason}`, rank: targetRank };
  }

  return {
    action: 'refuse',
    reason: `refused regression ${current} (${currentRank}) -> ${target} (${targetRank}); supply a rollback reason to force it`,
    rank: targetRank,
  };
}
