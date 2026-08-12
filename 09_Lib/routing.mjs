// Where a lead goes, who owns it, and what must not happen automatically.
//
// The governing rule for holds: gate the irreversible, not the reversible. Scoring
// and enrichment can always be redone, so a probable duplicate keeps moving through
// them. Creating a CRM record or messaging a human cannot be undone, so those wait.

export const ROUTING_VERSION = 'v1';

export function route({ lead, scored, conflict, dedup }) {
  const holds = [];
  let disposition;
  let reason;

  const tier = dedup?.tier ?? 'distinct';

  if (lead.disposition === 'data_completion') {
    disposition = 'data_completion';
    reason = lead.status_reason || 'critical contact data missing';
    holds.push({ what: 'outbound', why: 'lead has no reachable channel' });
  } else if (tier === 'auto_merge' && dedup.master_lead_id !== lead.lead_id) {
    // This record loses to an earlier one. It stops here; the master carries on.
    disposition = 'merged';
    reason = `folded into ${dedup.master_lead_id} at confidence ${dedup.best?.confidence}`;
    holds.push({ what: 'outbound', why: 'superseded by master record' });
    holds.push({ what: 'crm', why: 'superseded by master record' });
  } else if (conflict?.conflict) {
    disposition = 'manual_review';
    reason = conflict.reason;
  } else {
    disposition = scored.band;
    reason = `score ${scored.score} in band ${scored.band} under model ${scored.model_version}`;
  }

  if (tier === 'review' && disposition !== 'merged') {
    // Keep processing, but nothing irreversible until a human rules on it.
    holds.push({ what: 'crm', why: 'possible duplicate awaiting review' });
    holds.push({ what: 'outbound', why: 'possible duplicate awaiting review' });
  }

  const vip = Boolean(scored.vip) && disposition !== 'merged';
  if (vip) {
    // A transactional acknowledgement is not a sales action, so it is not held here.
    // Only sales outreach waits on the manager.
    holds.push({ what: 'sales_outreach', why: scored.vip_reason || 'VIP requires manager approval' });
  }

  if (lead.consent_status === 'denied' || lead.consent_status === 'withdrawn') {
    holds.push({ what: 'outbound', why: `consent ${lead.consent_status}` });
  }

  return {
    disposition,
    reason,
    vip,
    vip_reason: vip ? (scored.vip_reason ?? null) : null,
    approval_required: vip,
    holds,
    hold_outbound: holds.some((h) => h.what === 'outbound'),
    hold_crm: holds.some((h) => h.what === 'crm'),
    hold_sales_outreach: holds.some((h) => h.what === 'sales_outreach' || h.what === 'outbound'),
    assignable: disposition === 'qualified' || disposition === 'nurture',
    routing_version: ROUTING_VERSION,
  };
}

const loadRatio = (rep) => rep.open_leads / Math.max(rep.capacity, 1);

// Fallback ladder, most specific first. Each rung is recorded, so assignment_reason
// says not just who got the lead but how far we had to reach to find them.
const LADDER = [
  { level: 'category_and_region', match: (r, l) => matchesCategory(r, l) && matchesRegion(r, l) },
  { level: 'category_only',       match: (r, l) => matchesCategory(r, l) },
  { level: 'region_only',         match: (r, l) => matchesRegion(r, l) },
  { level: 'any_available',       match: () => true },
];

const matchesCategory = (rep, lead) =>
  !lead.service_interest || (rep.service_categories ?? []).includes(lead.service_interest);

const matchesRegion = (rep, lead) => {
  const region = lead.region ?? lead.enrichment?.data?.region;
  return !region || (rep.regions ?? []).includes(region);
};

export function assignRep({ lead, reps, overloadThreshold = 1 }) {
  // Availability and spare capacity are checked at assignment time, not read from a
  // stale snapshot. Edge case 9 is the same check happening again at dispatch.
  const eligible = (reps ?? []).filter((r) => r.available && loadRatio(r) < overloadThreshold);

  if (!eligible.length) {
    const anyAvailable = (reps ?? []).filter((r) => r.available);
    if (!anyAvailable.length) {
      return { rep_id: null, reason: 'no available rep — escalating to manager', fallback_level: 'none', escalate: true };
    }
    // Everyone is at or over capacity: give it to the least-loaded rather than
    // dropping it, and flag that the team is saturated.
    const least = [...anyAvailable].sort((a, b) => loadRatio(a) - loadRatio(b))[0];
    return {
      rep_id: least.rep_id,
      reason: `all reps at capacity; assigned least-loaded (${least.open_leads}/${least.capacity})`,
      fallback_level: 'over_capacity',
      escalate: true,
    };
  }

  for (const rung of LADDER) {
    const pool = eligible.filter((r) => rung.match(r, lead));
    if (!pool.length) continue;
    const pick = [...pool].sort((a, b) => loadRatio(a) - loadRatio(b) || a.rep_id.localeCompare(b.rep_id))[0];
    return {
      rep_id: pick.rep_id,
      reason: `${rung.level}: ${pick.rep_id} at ${pick.open_leads}/${pick.capacity}`,
      fallback_level: rung.level,
      escalate: false,
    };
  }

  return { rep_id: null, reason: 'no rep matched any fallback rung', fallback_level: 'none', escalate: true };
}
