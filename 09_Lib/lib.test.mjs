import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePhone, normalizeEmail, normalizeName, emailDedupKey, normalizeCompany } from './normalize.mjs';
import { effectKey, sourceEventKey, classifyFailure, nextBackoffMs, retryAfterMs } from './idempotency.mjs';
import { scoreLead, bandFor, detectConflict } from './scoring.mjs';
import { assess, jaroWinkler, tierFor, CIRCUMSTANTIAL_WEIGHTS } from './dedup.mjs';
import { toCanonical, validate } from './validate.mjs';
import { ulid, canonicalJson, sha256 } from './ids.mjs';

// ---------------------------------------------------------------- edge case 2
test('the same number in different formats normalises to one E.164 value', () => {
  const forms = ['+971 50 123 4567', '00971501234567', '0501234567', '971501234567', '(050) 123-4567'];
  const results = forms.map((f) => normalizePhone(f, 'AE'));
  for (const r of results) assert.equal(r.valid, true, `${r.raw} should parse`);
  assert.equal(new Set(results.map((r) => r.e164)).size, 1, 'all forms must collapse to one value');
  assert.equal(results[0].e164, '+971501234567');
});

test('phone normalisation reports why it failed instead of returning null', () => {
  assert.equal(normalizePhone('12345', 'AE').valid, false);
  assert.match(normalizePhone('12345', 'AE').reason, /bad_length/);
  assert.equal(normalizePhone('', 'AE').reason, 'missing');
  assert.equal(normalizePhone('+999123456789').reason, 'unknown_country_code');
});

test('email normalisation lowercases but dot-stripping stays a dedup-only concern', () => {
  assert.equal(normalizeEmail('  Amara.Okafor@Example.COM ').normalized, 'amara.okafor@example.com');
  assert.equal(normalizeEmail('no-at-sign').valid, false);
  assert.equal(normalizeEmail('a@b').valid, false, 'single-label domain is not deliverable');

  // The sending address keeps its dots; only the dedup key drops them.
  assert.equal(normalizeEmail('a.b+tag@gmail.com').normalized, 'a.b+tag@gmail.com');
  assert.equal(emailDedupKey('a.b+tag@gmail.com'), 'ab@gmail.com');
  assert.equal(emailDedupKey('a.b@example.com'), 'a.b@example.com', 'non-gmail keeps dots');
});

test('name and company normalisation strip noise, not identity', () => {
  assert.equal(normalizeName('Dr. José  Álvarez').normalized, 'jose alvarez');
  assert.equal(normalizeCompany('Northwind Industrial GmbH'), 'northwind industrial');
  assert.equal(normalizeCompany('Zenith Logistics FZ-LLC'), 'zenith logistics');
});

// --------------------------------------------------- idempotency key discipline
test('effect keys are stable and never contain execution context', () => {
  const a = effectKey({ domain: 'msg.send', entityId: '01ABC', occurrence: 'welcome' });
  const b = effectKey({ domain: 'msg.send', entityId: '01ABC', occurrence: 'welcome' });
  assert.equal(a, b, 'same effect must produce the same key on every attempt');
  assert.equal(a, 'v1:msg.send:lead:01ABC:welcome');

  // Different effects on the same lead must not collide.
  assert.notEqual(a, effectKey({ domain: 'msg.send', entityId: '01ABC', occurrence: 'followup.1' }));
  assert.notEqual(a, effectKey({ domain: 'odoo.lead.create', entityId: '01ABC' }));
});

test('a key part containing the separator is rejected rather than silently mangled', () => {
  assert.throws(() => effectKey({ domain: 'msg:send', entityId: '01ABC' }), /must not contain/);
});

// -------------------------------------------------- edge case 14 / redelivery
test('source event keys are content-derived, so redelivery maps to one lead', () => {
  const payload = { email: 'a@b.com', name: 'A', message: 'hi' };
  const k1 = sourceEventKey({ source: 'website', payload });
  const k2 = sourceEventKey({ source: 'website', payload: { message: 'hi', name: 'A', email: 'a@b.com' } });
  assert.equal(k1, k2, 'key order in the payload must not change the key');

  const k3 = sourceEventKey({ source: 'whatsapp', payload });
  assert.notEqual(k1, k3, 'the same content from a different source is a different event');

  // A provider id, when offered, beats hashing.
  assert.equal(sourceEventKey({ source: 'website', providerEventId: 'evt_1', payload }), 'website:id:evt_1');
});

// The Code node sandbox blocks require('crypto') and exposes no global crypto, so
// the hash ships with the workflow. That is only acceptable if it is provably the
// real thing, which is what this checks.
test('the bundled sha256 matches node:crypto, including at block boundaries', async () => {
  const { createHash } = await import('node:crypto');
  const ref = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

  const vectors = ['', 'a', 'abc', 'hello world',
    ...[55, 56, 57, 63, 64, 65, 119, 120, 1000].map((n) => 'x'.repeat(n))];
  for (const v of vectors) assert.equal(sha256(v), ref(v), `length ${v.length}`);

  for (let i = 0; i < 500; i++) {
    let s = '';
    for (let j = 0; j < Math.floor(Math.random() * 200); j++) {
      s += String.fromCodePoint(Math.floor(Math.random() * 0x2000) + 1);
    }
    assert.equal(sha256(s), ref(s), 'unicode fuzz');
  }
});

test('canonical json sorts keys at every depth', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test('ulids sort in generation order', () => {
  const early = ulid(1_700_000_000_000);
  const late = ulid(1_700_000_001_000);
  assert.ok(early < late, 'lexicographic order must follow time order');
  assert.equal(early.length, 26);
});

// ------------------------------------------------------------- edge cases 6, I
test('failures are classified before they are retried', () => {
  assert.equal(classifyFailure({ status: 429 }).retryable, true);
  assert.equal(classifyFailure({ status: 429 }).reason, 'rate_limited');
  assert.equal(classifyFailure({ status: 503 }).retryable, true);
  assert.equal(classifyFailure({ code: 'ECONNRESET' }).retryable, true);

  // Retrying these is pure waste, and the brief calls out missing credentials.
  assert.equal(classifyFailure({ status: 401 }).retryable, false);
  assert.equal(classifyFailure({ status: 401 }).reason, 'auth');
  assert.equal(classifyFailure({ status: 422 }).retryable, false);
});

test('backoff is bounded, jittered, and honours Retry-After when offered', () => {
  const ceiling = (attempt) => Math.min(2000 * 2 ** attempt, 900_000);
  for (let attempt = 0; attempt < 12; attempt++) {
    for (let i = 0; i < 50; i++) {
      const ms = nextBackoffMs(attempt);
      assert.ok(ms >= 0 && ms <= ceiling(attempt), `attempt ${attempt} produced ${ms}`);
    }
  }
  // Full jitter, so the delay spans the whole window rather than clustering.
  assert.ok(nextBackoffMs(0, { random: () => 0.999 }) < 2000);
  assert.equal(nextBackoffMs(3, { random: () => 0 }), 0);
  assert.equal(nextBackoffMs(3, { random: () => 0.5 }), 8000);

  // The cap holds no matter how many attempts have accumulated.
  assert.equal(nextBackoffMs(50, { random: () => 0.999 }) <= 900_000, true);

  assert.equal(retryAfterMs({ 'retry-after': '2' }), 2000);
  assert.equal(retryAfterMs({}), null);
});

// -------------------------------------------------------------- scoring bands
test('scoring is deterministic and every point is attributable', () => {
  const lead = {
    service_interest: 'implementation', budget_band: '100k-500k', timeline: 'immediate',
    email_normalized: 'ceo@northwind-industrial.com', phone_e164: '+971501234567',
    company: 'Northwind Industrial', free_text_need: 'We need a company-wide rollout across four sites.',
    country: 'DE', region: 'EMEA',
    enrichment: { status: 'ok', data: { company_size: 4200, industry: 'manufacturing', revenue_band: '500m-1b', strategic_account: true, region: 'EMEA' } },
  };
  const a = scoreLead(lead);
  const b = scoreLead(lead);
  assert.deepEqual(a, b, 'identical input must produce identical output');
  assert.equal(a.score, 100);
  assert.equal(a.band, 'qualified');
  assert.equal(a.vip, true);
  // The breakdown reconciles to the final score, cap adjustment included, so the
  // audit trail never shows points that went nowhere.
  assert.equal(a.breakdown.reduce((n, r) => n + r.points, 0), a.score);
  assert.ok(a.raw_score > 100, 'this lead genuinely earns more than the ceiling');
  assert.ok(a.breakdown.some((r) => r.rule_id === 'cap'), 'the cap is itself an audited rule');
  assert.ok(a.breakdown.every((r) => r.reason), 'every rule must explain itself');
});

test('a thin lead lands unqualified, a mid lead lands nurture', () => {
  const thin = scoreLead({ free_text_need: 'hi', enrichment: { data: {} } });
  assert.equal(thin.band, 'unqualified');
  assert.ok(thin.score < 40);

  const mid = scoreLead({
    service_interest: 'consulting', timeline: 'six_months', country: 'US', region: 'AMER',
    email_normalized: 'a@brightpath.co', phone_e164: '+12025550100', company: 'Brightpath',
    free_text_need: 'Looking at options for a small consulting engagement next quarter.',
    enrichment: { status: 'ok', data: { company_size: 9, industry: 'consulting', revenue_band: '<1m' } },
  });
  assert.equal(mid.band, 'nurture', `expected nurture, got ${mid.score}`);
});

test('the strategic account flag makes a lead VIP regardless of score', () => {
  const s = scoreLead({ enrichment: { status: 'ok', data: { strategic_account: true } } });
  assert.equal(s.vip, true);
  assert.equal(s.vip_reason, 'strategic account flag');
  assert.ok(s.score < 90, 'this lead is VIP by flag, not by score');
});

assert.equal(bandFor(70), 'qualified');
assert.equal(bandFor(69), 'nurture');
assert.equal(bandFor(40), 'nurture');
assert.equal(bandFor(39), 'unqualified');

// ------------------------------------------------------------- edge cases 4, 5
test('a confident AI disagreement two bands out is a material conflict', () => {
  const r = detectConflict({ band: 'unqualified', ai: { label: 'high_potential', confidence: 0.91 } });
  assert.equal(r.conflict, true);
  assert.equal(r.distance, 2);
  assert.match(r.reason, /2 bands apart/);
});

test('adjacent disagreement and low confidence are tolerated', () => {
  assert.equal(detectConflict({ band: 'nurture', ai: { label: 'high_potential', confidence: 0.95 } }).conflict, false);
  assert.equal(detectConflict({ band: 'unqualified', ai: { label: 'high_potential', confidence: 0.4 } }).conflict, false);
});

test('an unusable AI response never manufactures a conflict', () => {
  assert.equal(detectConflict({ band: 'qualified', ai: null }).conflict, false);
  assert.equal(detectConflict({ band: 'qualified', ai: { label: null, fallback_used: true } }).conflict, false);
  assert.equal(detectConflict({ band: 'qualified', ai: { label: 'nonsense', confidence: 0.9 } }).conflict, false);
});

// ------------------------------------------------------------- edge case 1
test('the same person from two sources within minutes is caught as a duplicate', () => {
  const web = {
    lead_id: '01AAA', source: 'website', full_name: 'Amara Okafor',
    email_normalized: 'amara.okafor@northwind-industrial.com', phone_e164: '+971501234567',
    company: 'Northwind Industrial', ingested_at: '2026-08-12T10:00:00Z',
  };
  const wa = {
    lead_id: '01BBB', source: 'whatsapp', full_name: 'Amara O.',
    email_normalized: null, phone_e164: '+971501234567',
    company: null, ingested_at: '2026-08-12T10:01:30Z',
  };

  const r = assess(wa, [web]);
  assert.equal(r.tier, 'auto_merge');
  assert.equal(r.best.decisive, true);
  assert.equal(r.best.features.phone_exact, true);
  assert.equal(r.best.features.cross_source, true);
  assert.equal(r.master_lead_id, '01AAA', 'the earlier ULID becomes the master');
});

test('a shared phone with a contradicting name and email is demoted to review', () => {
  const a = {
    lead_id: '01AAA', source: 'website', full_name: 'Amara Okafor',
    email_normalized: 'amara@northwind-industrial.com', phone_e164: '+97144000000',
    ingested_at: '2026-08-12T10:00:00Z',
  };
  const b = {
    lead_id: '01BBB', source: 'website', full_name: 'Tobias Vermeulen',
    email_normalized: 'tobias@northwind-industrial.com', phone_e164: '+97144000000',
    ingested_at: '2026-08-12T11:00:00Z',
  };
  const r = assess(b, [a]);
  assert.equal(r.tier, 'review', 'an office line must not auto-merge two people');
  assert.ok(r.best.contradictions.length >= 2);
});

test('unrelated leads score as distinct', () => {
  const a = { lead_id: '01AAA', source: 'website', full_name: 'Amara Okafor', email_normalized: 'amara@a.com', phone_e164: '+971501234567', ingested_at: '2026-08-12T10:00:00Z' };
  const b = { lead_id: '01BBB', source: 'csv', full_name: 'Yuki Tanaka', email_normalized: 'yuki@b.com', phone_e164: '+818012345678', ingested_at: '2026-08-01T10:00:00Z' };
  assert.equal(assess(b, [a]).tier, 'distinct');
});

test('a full house of identity evidence auto-merges without an identifier match', () => {
  const work = { lead_id: '01AAA', source: 'website', full_name: 'Luis Ferreira', email_normalized: 'luis.ferreira@zenith-logistics.com', company: 'Zenith Logistics', ingested_at: '2026-08-12T10:00:00Z' };
  const personal = { lead_id: '01BBB', source: 'whatsapp', full_name: 'Luis Ferreira', email_normalized: 'luis.ferreira@gmail.com', company: 'Zenith Logistics Ltd', ingested_at: '2026-08-12T12:00:00Z' };
  const r = assess(personal, [work]);
  assert.equal(r.best.decisive, false, 'no phone or email matched exactly');
  assert.equal(r.tier, 'auto_merge', `got ${r.tier} at ${r.best.confidence}`);
});

test('dropping one identity signal from that pair drops it back to review', () => {
  const work = { lead_id: '01AAA', source: 'website', full_name: 'Luis Ferreira', email_normalized: 'luis.ferreira@zenith-logistics.com', company: 'Zenith Logistics', ingested_at: '2026-08-12T10:00:00Z' };
  const noCompany = { lead_id: '01BBB', source: 'whatsapp', full_name: 'Luis Ferreira', email_normalized: 'luis.ferreira@gmail.com', company: null, ingested_at: '2026-08-12T12:00:00Z' };
  assert.equal(assess(noCompany, [work]).tier, 'review');
});

// Guards the weight table itself. If someone later raises a circumstantial weight,
// this fails before it can quietly start merging people who merely arrived together.
test('circumstantial evidence alone can never carry an auto-merge', () => {
  const circumstantial = Object.values(CIRCUMSTANTIAL_WEIGHTS).reduce((a, b) => a + b, 0);
  const gap = 0.90 - 0.65;
  assert.ok(circumstantial < gap,
    `circumstantial weights total ${circumstantial}, which must stay below the ${gap} band gap`);
});

test('thresholds are parameters, not constants baked into the tiering', () => {
  assert.equal(tierFor(0.95), 'auto_merge');
  assert.equal(tierFor(0.95, { autoMerge: 0.99, review: 0.65 }), 'review');
  assert.equal(jaroWinkler('amara okafor', 'amara okafor'), 1);
  assert.ok(jaroWinkler('amara okafor', 'amara o') > 0.8);
});

// ------------------------------------------------- intake + edge case 13
test('each source maps its own field names onto one canonical shape', () => {
  const web = toCanonical({ source: 'website', payload: { name: 'Amara Okafor', email: 'A@Northwind-Industrial.com', phone: '050 123 4567', service: 'implementation', message: 'need a rollout', consent: 'yes' } });
  assert.equal(web.email_normalized, 'a@northwind-industrial.com');
  assert.equal(web.phone_e164, '+971501234567');
  assert.equal(web.consent_status, 'granted');
  assert.deepEqual(web.channels_allowed.sort(), ['email', 'whatsapp']);

  const wa = toCanonical({ source: 'whatsapp', payload: { profile_name: 'Amara', wa_id: '971501234567', text: 'hello' } });
  assert.equal(wa.phone_e164, '+971501234567');
  assert.equal(wa.consent_status, 'granted', 'an inbound message is consent to reply');
  assert.deepEqual(wa.channels_allowed, ['whatsapp'], 'but not consent to email them');
});

test('a lead with no reachable channel is diverted, not dropped', () => {
  const lead = toCanonical({ source: 'csv', payload: { name: 'Broken Row', phone: 'not-a-phone', email: 'also-not-an-email' } });
  const v = validate(lead);
  assert.equal(v.ok, false);
  assert.equal(v.disposition, 'data_completion');
  assert.match(v.reason, /no_reachable_channel/);
  assert.ok(v.warnings.some((w) => w.code === 'unparseable'));
});

test('a valid lead passes with warnings that travel alongside it', () => {
  const lead = toCanonical({ source: 'csv', payload: { name: 'Fine Row', email: 'fine@lumen-health.io' } });
  const v = validate(lead);
  assert.equal(v.ok, true);
  assert.equal(v.disposition, null);
  assert.ok(v.warnings.some((w) => w.field === 'service_interest'));
});

test('denied consent is recorded and permits no channel', () => {
  const lead = toCanonical({ source: 'website', payload: { name: 'No Thanks', email: 'x@lumen-health.io', consent: 'no' } });
  assert.equal(lead.consent_status, 'denied');
  assert.deepEqual(lead.channels_allowed, []);
  assert.equal(validate(lead).ok, true, 'refusing marketing is not a data quality problem');
});
