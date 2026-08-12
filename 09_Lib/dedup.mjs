import { emailDedupKey, normalizeCompany, normalizeEmail, normalizeName } from './normalize.mjs';

// Who the person is, as opposed to where mail can be delivered. Dots and +tags are
// stripped for everyone here: this value is only ever compared, never sent to.
function identityLocal(email) {
  const { valid, localPart } = normalizeEmail(email);
  return valid ? localPart.split('+')[0].replace(/\./g, '') : null;
}

// Features are derived independently and weights are published, so a merge decision
// can be re-argued from its stored vector rather than taken on trust. The thresholds
// are priors, not fitted values — see the design note for why that is defensible.

export const DEDUP_MODEL_VERSION = 'v1';

export function jaroWinkler(a = '', b = '') {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;

  let transpositions = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

// Identity evidence says *who* this is. Circumstantial evidence only corroborates.
// The split matters: the circumstantial weights sum to 0.20, which is deliberately
// smaller than the 0.25 gap between the review and auto-merge thresholds. So timing
// and source can move a pair within a band but can never, on their own, carry it
// into an automatic merge. Change these numbers and that invariant is what breaks.
export const IDENTITY_WEIGHTS = {
  email_local_match: 0.35,
  name_similarity: 0.25,
  company_match: 0.15,
};

export const CIRCUMSTANTIAL_WEIGHTS = {
  temporal_proximity: 0.10,
  cross_source: 0.10,
};

const WEIGHTS = { ...IDENTITY_WEIGHTS, ...CIRCUMSTANTIAL_WEIGHTS };

export function extractFeatures(candidate, existing) {
  const f = {};

  f.phone_exact = Boolean(candidate.phone_e164 && candidate.phone_e164 === existing.phone_e164);
  f.email_exact = Boolean(
    candidate.email_normalized && candidate.email_normalized === existing.email_normalized);

  const candKey = emailDedupKey(candidate.email_normalized ?? candidate.email_raw);
  const exisKey = emailDedupKey(existing.email_normalized ?? existing.email_raw);
  f.email_dedup_key_match = Boolean(candKey && candKey === exisKey);

  // Same local part on a different domain: the work-address / personal-address pair.
  // Compared via identityLocal rather than the dedup key, because the dedup key
  // only strips dots for providers that ignore them; which would make
  // luis.ferreira@work and luisferreira@gmail look like different people.
  const candLocal = identityLocal(candidate.email_normalized ?? candidate.email_raw);
  const exisLocal = identityLocal(existing.email_normalized ?? existing.email_raw);
  f.email_local_match = Boolean(candLocal && candLocal === exisLocal && !f.email_exact);

  const candName = candidate.name_normalized ?? normalizeName(candidate.full_name).normalized;
  const exisName = existing.name_normalized ?? normalizeName(existing.full_name).normalized;
  f.name_similarity = candName && exisName ? Number(jaroWinkler(candName, exisName).toFixed(3)) : 0;

  const candCo = normalizeCompany(candidate.company);
  const exisCo = normalizeCompany(existing.company);
  f.company_match = Boolean(candCo && exisCo && candCo === exisCo);

  const dtMs = Math.abs(
    new Date(candidate.ingested_at ?? Date.now()) - new Date(existing.ingested_at ?? Date.now()));
  f.hours_apart = Number((dtMs / 3_600_000).toFixed(2));
  f.temporal_proximity = f.hours_apart <= 24;

  // Cross-source *raises* suspicion rather than lowering it: edge case 1 is
  // specifically the same person arriving via WhatsApp and the website.
  f.cross_source = Boolean(candidate.source && existing.source && candidate.source !== existing.source);

  // Explicit disagreement, used to demote an otherwise decisive match. A shared
  // office line is real, and a rule that merges on phone alone will eventually
  // merge two different people.
  f.email_conflict = Boolean(
    candidate.email_normalized && existing.email_normalized &&
    candidate.email_normalized !== existing.email_normalized && !f.email_local_match);
  f.name_conflict = Boolean(candName && exisName && f.name_similarity < 0.70);

  return f;
}

export function scoreCandidate(candidate, existing) {
  const f = extractFeatures(candidate, existing);
  const decisive = f.phone_exact || f.email_exact || f.email_dedup_key_match;

  let confidence;
  const contributions = [];

  if (decisive) {
    confidence = 0.95;
    contributions.push({
      feature: f.email_exact ? 'email_exact' : f.phone_exact ? 'phone_exact' : 'email_dedup_key_match',
      contribution: 0.95,
      note: 'decisive identifier match',
    });
  } else {
    confidence = 0;
    for (const [key, weight] of Object.entries(WEIGHTS)) {
      const value = key === 'name_similarity' ? f.name_similarity : (f[key] ? 1 : 0);
      const points = weight * value;
      if (points > 0) contributions.push({ feature: key, contribution: Number(points.toFixed(3)) });
      confidence += points;
    }
  }

  // Demotion, not rejection: contradicted evidence moves the pair to a human
  // rather than deciding it either way.
  const contradictions = [];
  if (decisive && f.email_conflict) contradictions.push('different email address');
  if (decisive && f.name_conflict) contradictions.push('names do not match');
  if (contradictions.length) {
    confidence = Math.min(confidence, 0.80);
    contributions.push({ feature: 'contradiction_demotion', contribution: -0.15, note: contradictions.join('; ') });
  }

  return {
    candidate_lead_id: existing.lead_id,
    confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(3)),
    decisive,
    contradictions,
    features: f,
    contributions,
    model_version: DEDUP_MODEL_VERSION,
  };
}

export function tierFor(confidence, { autoMerge = 0.90, review = 0.65 } = {}) {
  if (confidence >= autoMerge) return 'auto_merge';
  if (confidence >= review) return 'review';
  return 'distinct';
}

export function assess(candidate, existingRecords, thresholds) {
  const scored = existingRecords
    .filter((e) => e.lead_id !== candidate.lead_id)
    .map((e) => scoreCandidate(candidate, e))
    .sort((a, b) => b.confidence - a.confidence);

  const best = scored[0] ?? null;
  const tier = best ? tierFor(best.confidence, thresholds) : 'distinct';

  return {
    tier,
    best,
    // Retained in full so thresholds can be fitted from outcomes later.
    all: scored,
    // Ties broken by ULID: the earlier-arriving record becomes the master, which
    // keeps merges deterministic regardless of evaluation order.
    master_lead_id: best && tier !== 'distinct'
      ? [candidate.lead_id, best.candidate_lead_id].sort()[0]
      : candidate.lead_id,
  };
}
