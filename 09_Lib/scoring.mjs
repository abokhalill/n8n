// Deterministic only. The AI classification never feeds this, because a score that depends
// on a non-deterministic model cannot be reproduced, explained after the fact, or
// regression tested. Disagreement between the two is handled as a routing signal.

export const SCORE_MODEL_VERSION = 'v1';

const TARGET_INDUSTRIES = { manufacturing: 10, logistics: 10, healthcare: 10, consulting: 4, retail: 4 };
const SERVICE_POINTS = { implementation: 15, consulting: 12, training: 6, support: 4 };
const TIMELINE_POINTS = { immediate: 15, this_quarter: 10, six_months: 5, exploring: 0 };
const BUDGET_POINTS = { '>1m': 20, '500k-1m': 16, '100k-500k': 12, '50k-100k': 8, '10k-50k': 4, '<10k': 0 };
const REVENUE_FALLBACK = { '500m-1b': 12, '100m-500m': 10, '50m-100m': 8, '10m-50m': 6, '1m-10m': 4, '<1m': 2 };
const SERVED_REGIONS = new Set(['EMEA', 'MEA', 'APAC', 'AMER']);

function headcountPoints(size) {
  if (!Number.isFinite(size)) return [0, 'no headcount data'];
  if (size >= 1000) return [20, `${size} staff, enterprise`];
  if (size >= 250) return [15, `${size} staff, upper mid-market`];
  if (size >= 50) return [10, `${size} staff, mid-market`];
  if (size >= 10) return [5, `${size} staff, small business`];
  return [0, `${size} staff, micro business`];
}

export function scoreLead(lead) {
  const enriched = lead.enrichment?.data ?? {};
  const rules = [];
  const add = (rule_id, points, reason) => rules.push({ rule_id, points, reason });

  const [sizePts, sizeReason] = headcountPoints(Number(enriched.company_size));
  add('company_size', sizePts, sizeReason);

  const industry = String(enriched.industry ?? '').toLowerCase();
  add('industry_fit', TARGET_INDUSTRIES[industry] ?? 0,
    industry ? `industry ${industry}` : 'industry unknown');

  const service = String(lead.service_interest ?? '').toLowerCase();
  add('service_interest', SERVICE_POINTS[service] ?? 0,
    service ? `interested in ${service}` : 'no service interest given');

  // Self-reported budget is the better signal when present; company revenue is a
  // proxy, so it is only consulted when the lead did not tell us.
  const budget = String(lead.budget_band ?? '').toLowerCase();
  if (budget && budget in BUDGET_POINTS) {
    add('budget_band', BUDGET_POINTS[budget], `stated budget ${budget}`);
  } else {
    const rev = String(enriched.revenue_band ?? '');
    add('budget_band', REVENUE_FALLBACK[rev] ?? 0,
      rev ? `no stated budget; revenue band ${rev}` : 'no budget or revenue signal');
  }

  const timeline = String(lead.timeline ?? '').toLowerCase();
  add('timeline', TIMELINE_POINTS[timeline] ?? 0,
    timeline ? `timeline ${timeline}` : 'no timeline given');

  // Completeness is a genuine quality signal, not padding: a lead that answered
  // everything is measurably more likely to engage than one that gave a phone number.
  const present = [
    [lead.email_normalized, 'email'],
    [lead.phone_e164, 'phone'],
    [lead.company, 'company'],
    [String(lead.free_text_need ?? '').length >= 20 ? 'y' : '', 'described need'],
    [lead.country, 'country'],
  ].filter(([v]) => Boolean(v)).map(([, label]) => label);
  add('completeness', present.length * 2, `provided ${present.join(', ') || 'almost nothing'}`);

  const region = lead.region ?? enriched.region;
  add('region_served', SERVED_REGIONS.has(region) ? 10 : 0,
    region ? `region ${region}` : 'region unknown');

  add('strategic_account', enriched.strategic_account ? 15 : 0,
    enriched.strategic_account ? 'flagged strategic account' : 'not a strategic account');

  const raw = rules.reduce((n, r) => n + r.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  if (raw > 100) rules.push({ rule_id: 'cap', points: 100 - raw, reason: `raw ${raw} capped to 100` });

  return {
    score,
    raw_score: raw,
    breakdown: rules,
    model_version: SCORE_MODEL_VERSION,
    band: bandFor(score),
    vip: score >= 90 || Boolean(enriched.strategic_account),
    vip_reason: score >= 90 ? 'score >= 90'
      : enriched.strategic_account ? 'strategic account flag' : null,
  };
}

export function bandFor(score) {
  if (score >= 70) return 'qualified';
  if (score >= 40) return 'nurture';
  return 'unqualified';
}

const BAND_ORDER = ['unqualified', 'nurture', 'qualified'];
const AI_TO_BAND = { spam: 'unqualified', low_intent: 'unqualified', moderate: 'nurture', high_potential: 'qualified' };

// "Materially conflict" is undefined in the brief, so it is defined here: more than
// one band apart, and the model was confident. Adjacent disagreement is noise, and
// treating it as conflict would send most of the funnel to manual review.
export const CONFLICT_PREDICATE_VERSION = 'v1';

export function detectConflict({ band, ai }) {
  if (!ai || !ai.label || ai.fallback_used) {
    return { conflict: false, reason: 'no usable AI classification', predicate_version: CONFLICT_PREDICATE_VERSION };
  }
  const aiBand = AI_TO_BAND[ai.label];
  if (!aiBand) {
    return { conflict: false, reason: `unmapped AI label ${ai.label}`, predicate_version: CONFLICT_PREDICATE_VERSION };
  }
  const distance = Math.abs(BAND_ORDER.indexOf(aiBand) - BAND_ORDER.indexOf(band));
  const confident = Number(ai.confidence ?? 0) >= 0.6;
  const conflict = distance > 1 && confident;
  return {
    conflict,
    distance,
    ai_band: aiBand,
    rule_band: band,
    confidence: ai.confidence ?? null,
    reason: conflict
      ? `AI says ${aiBand} at ${ai.confidence}, rules say ${band}, ${distance} bands apart`
      : `distance ${distance}, confidence ${ai.confidence ?? 'n/a'}, within tolerance`,
    predicate_version: CONFLICT_PREDICATE_VERSION,
  };
}
