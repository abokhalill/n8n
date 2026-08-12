// Verifies the harness itself, not the pipeline. If any of these fail, the edge-case
// evidence in 05_Test_Evidence is worthless, because the failures it claims to
// reproduce were never actually reproducible.
//
//   node selftest.mjs            (expects the mock service on :8080)
//   BASE=http://localhost:8099 node selftest.mjs

const BASE = process.env.BASE ?? 'http://localhost:8080';

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  ok ? pass++ : fail++;
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const j = async (path, opts = {}) => {
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
};

const post = (path, body, headers = {}) =>
  j(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const armFault = (spec) => post('/_control/faults', spec);

async function main() {
  console.log(`\nharness self-test against ${BASE}\n${'-'.repeat(64)}`);
  await post('/_control/reset', {});

  // ---- Odoo: create, replay, reconcile -------------------------------------
  const KEY = 'v1:odoo.lead.create:lead:01SELFTEST:1';
  const c1 = await post('/odoo/leads', { name: 'Selftest Co' }, { 'idempotency-key': KEY });
  check('odoo create returns 201', c1.status === 201, `got ${c1.status}`);

  const c2 = await post('/odoo/leads', { name: 'Selftest Co' }, { 'idempotency-key': KEY });
  check('odoo replays same key without creating a second record',
    c2.status === 200 && c2.body.replayed === true && c2.body.id === c1.body.id,
    `id ${c2.body.id} vs ${c1.body.id}`);

  const missingKey = await post('/odoo/leads', { name: 'No Key' });
  check('odoo refuses a create with no Idempotency-Key', missingKey.status === 400);

  // The endpoint edge case 7 depends on: after a lost ack, ask whether the effect landed.
  const look = await j(`/odoo/leads/lookup?idempotency_key=${encodeURIComponent(KEY)}`);
  check('odoo reconciliation lookup finds the effect by key',
    look.status === 200 && look.body.found === true && look.body.lead.id === c1.body.id);

  const lookMiss = await j('/odoo/leads/lookup?idempotency_key=v1:never:happened');
  check('odoo reconciliation reports a genuine miss as 404', lookMiss.status === 404);

  // ---- Odoo: the stage lattice ---------------------------------------------
  const id = c1.body.id;
  const fwd = await post(`/odoo/leads/${id}/stage`, { stage: 'qualified' });
  check('stage advances forward', fwd.status === 200 && fwd.body.stage === 'qualified');

  const same = await post(`/odoo/leads/${id}/stage`, { stage: 'qualified' });
  check('re-setting the current stage is a no-op, not a conflict',
    same.status === 200 && same.body.changed === false);

  const back = await post(`/odoo/leads/${id}/stage`, { stage: 'contacted' });
  check('stage regression refused with 409', back.status === 409, back.body.error);

  const rollback = await post(`/odoo/leads/${id}/stage`, { stage: 'contacted', rollback_reason: 'vip_rejected' });
  check('explicit rollback is permitted and recorded',
    rollback.status === 200 && rollback.body.stage === 'contacted' &&
    rollback.body.stage_history.at(-1).rollback === true);

  // ---- WhatsApp: exactly-once ----------------------------------------------
  const MKEY = 'v1:msg.send:lead:01SELFTEST:welcome';
  const m1 = await post('/whatsapp/messages', { to: '+971500000000', body: 'hi' }, { 'idempotency-key': MKEY });
  const m2 = await post('/whatsapp/messages', { to: '+971500000000', body: 'hi' }, { 'idempotency-key': MKEY });
  check('whatsapp send then retry yields one message id',
    m1.body.message_id === m2.body.message_id && m2.body.replayed === true);

  const tally = await j(`/_control/journal/tally?provider=whatsapp&idempotency_key=${encodeURIComponent(MKEY)}`);
  check('journal distinguishes delivered from replayed',
    tally.body.calls === 2 && tally.body.delivered === 1 && tally.body.replayed === 1,
    JSON.stringify(tally.body));

  // ---- Enrichment ----------------------------------------------------------
  const hit = await j('/enrich?email=ceo@northwind-industrial.com');
  check('enrichment hit returns firmographics and the strategic flag',
    hit.body.found === true && hit.body.data.strategic_account === true);

  const miss = await j('/enrich?email=someone@unknown-domain.test');
  check('enrichment miss is a 200 with found:false, not an error',
    miss.status === 200 && miss.body.found === false);

  // ---- LLM -----------------------------------------------------------------
  const ai1 = await post('/ai/classify', { free_text_need: 'Enterprise rollout, budget approved, CTO sponsor, urgent' });
  const ai2 = await post('/ai/classify', { free_text_need: 'Enterprise rollout, budget approved, CTO sponsor, urgent' });
  check('llm is deterministic for identical input',
    ai1.body.label === ai2.body.label && ai1.body.confidence === ai2.body.confidence,
    `${ai1.body.label}@${ai1.body.confidence}`);
  check('llm reads a strong brief as high_potential', ai1.body.label === 'high_potential');

  const junk = await post('/ai/classify', { free_text_need: 'cheap backlink and seo services, click here' });
  check('llm reads spam as spam', junk.body.label === 'spam');

  // ---- Fault: 429 with Retry-After (edge case 6) ---------------------------
  await armFault({ id: 'f429', provider: 'odoo', mode: 'status', status: 429, headers: { 'retry-after': '2' }, times: 1 });
  const r429 = await post('/odoo/leads', { name: 'x' }, { 'idempotency-key': 'k429' });
  check('429 injected with a Retry-After header',
    r429.status === 429 && r429.headers.get('retry-after') === '2');

  const after429 = await post('/odoo/leads', { name: 'x' }, { 'idempotency-key': 'k429' });
  check('fault budget of 1 is consumed, next call succeeds', after429.status === 201);

  // ---- Fault: timeout twice then succeed (edge case 3) ---------------------
  await armFault({ id: 'f3', provider: 'enrichment', mode: 'timeout', times: 2, note: 'edge case 3' });
  const attempts = [];
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(`${BASE}/enrich?email=ceo@zenith-logistics.com`, { signal: AbortSignal.timeout(1200) });
      attempts.push(r.status);
    } catch {
      attempts.push('timeout');
    }
  }
  check('enrichment times out exactly twice, then succeeds',
    attempts[0] === 'timeout' && attempts[1] === 'timeout' && attempts[2] === 200,
    attempts.join(' -> '));

  // ---- Fault: malformed and empty AI responses (edge case 4) ---------------
  await armFault({ id: 'f4a', provider: 'llm', mode: 'malformed', times: 1 });
  const bad = await post('/ai/classify', { free_text_need: 'anything' });
  check('llm can return truncated JSON', bad.status === 200 && typeof bad.body === 'string');

  await armFault({ id: 'f4b', provider: 'llm', mode: 'empty', times: 1 });
  const empty = await post('/ai/classify', { free_text_need: 'anything' });
  check('llm can return an empty body', empty.status === 200 && empty.body === '');

  // ---- Fault: forced confident disagreement (edge case 5) -----------------
  await armFault({
    id: 'f5', provider: 'llm', mode: 'respond', times: 1,
    body: { label: 'high_potential', confidence: 0.91, rationale: 'forced', model: 'mock-classifier-v1' },
  });
  const forced = await post('/ai/classify', { free_text_need: 'just browsing, no budget, student project' });
  check('llm can be forced to a confident label that contradicts the rules',
    forced.body.label === 'high_potential' && forced.body.confidence === 0.91);

  // ---- Fault: connection reset (brief section I, "unavailable service") ---
  await armFault({ id: 'frst', provider: 'whatsapp', mode: 'reset', times: 1 });
  let reset = 'no-error';
  try {
    await fetch(`${BASE}/whatsapp/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'krst' },
      body: JSON.stringify({ to: '+1', body: 'x' }),
    });
  } catch (err) {
    reset = err.cause?.code ?? err.message;
  }
  check('socket reset surfaces as a transport error, not an HTTP status',
    reset !== 'no-error', String(reset));

  // ---- Fault targeting by key ---------------------------------------------
  await armFault({ id: 'fkey', provider: 'whatsapp', mode: 'status', status: 503, match: { idempotency_key: 'only-me' } });
  const targeted = await post('/whatsapp/messages', { to: '+1', body: 'x' }, { 'idempotency-key': 'only-me' });
  const untargeted = await post('/whatsapp/messages', { to: '+1', body: 'x' }, { 'idempotency-key': 'someone-else' });
  check('faults can be scoped to a single idempotency key',
    targeted.status === 503 && untargeted.status === 201);
  await j('/_control/faults/fkey', { method: 'DELETE' });

  // ---- One-shot inline directive ------------------------------------------
  const inline = await post('/enrich', {}, { 'x-fault-directive': JSON.stringify({ mode: 'status', status: 500 }) });
  const afterInline = await j('/enrich?email=a@brightpath.co');
  check('inline directive affects exactly one request',
    inline.status === 500 && afterInline.status === 200);

  // ---- Fault: effect lands, acknowledgement lost (edge case 7) ------------
  await armFault({ id: 'fdrop', provider: 'odoo', route: 'POST /odoo/leads', mode: 'drop_response', times: 1 });
  const DROPKEY = 'v1:odoo.lead.create:lead:01DROPTEST:1';
  let clientSaw = 'a response';
  try {
    await fetch(`${BASE}/odoo/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': DROPKEY },
      body: JSON.stringify({ name: 'Ghost Record' }),
      signal: AbortSignal.timeout(4000),
    });
  } catch { clientSaw = 'nothing'; }
  const ghost = await j(`/odoo/leads/lookup?idempotency_key=${encodeURIComponent(DROPKEY)}`);
  check('drop_response loses the acknowledgement but keeps the effect',
    clientSaw === 'nothing' && ghost.status === 200 && ghost.body.found === true,
    `client saw ${clientSaw}`);

  // ---- Duplicate webhook delivery (edge case 11) --------------------------
  // No n8n in this self-test, so delivery fails at the transport. What is being
  // checked is that the emitter attempts the *same* payload twice.
  const emit = await post('/_control/emit/booking', { lead_id: '01SELFTEST', booking_id: 'BK-SELF', times: 2 });
  check('booking emitter attempts identical delivery twice',
    emit.body.deliveries?.length === 2 && emit.body.booking.booking_id === 'BK-SELF');

  const bk = await j('/booking/BK-SELF');
  check('emitted booking is retrievable by id', bk.status === 200 && bk.body.lead_id === '01SELFTEST');

  console.log('-'.repeat(64));
  console.log(`${pass} passed, ${fail} failed\n`);
  if (fail) {
    console.log('failures:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name} ${r.detail}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('selftest crashed:', e); process.exit(2); });
