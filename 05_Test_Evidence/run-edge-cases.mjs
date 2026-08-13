#!/usr/bin/env node
// Runs all fourteen mandatory edge cases against the live stack and prints pass/fail.
//
//   docker compose up -d --build && ./scripts/bootstrap.sh
//   node 05_Test_Evidence/run-edge-cases.mjs
//   node 05_Test_Evidence/run-edge-cases.mjs 7 8 11      # a subset
//
// Every case resets the database and the mock harness first, so cases are
// independent and can be run in any order.d.

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

const N8N = `http://localhost:${env.N8N_PORT || 5678}`;
const MOCKS = `http://localhost:${env.MOCKS_PORT || 8080}`;
const PGUSER = env.POSTGRES_USER || 'leadops';

// ---------------------------------------------------------------- plumbing
const psql = (q, db = 'leadops') =>
  execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', PGUSER, '-d', db, '-tAc', q],
    { cwd: ROOT, encoding: 'utf8' }).trim();

const rows = (q) => {
  const out = psql(`SELECT COALESCE(json_agg(t), '[]') FROM (${q}) t`);
  return JSON.parse(out || '[]');
};
const one = (q) => rows(q)[0] ?? null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: null, error: e.message };
  }
}

const post = (url, body, headers = {}) =>
  http(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });

const intake = (source, payload) => post(`${N8N}/webhook/intake/${source}`, payload);
const tick = (what) => post(`${N8N}/webhook/ops/tick/${what}`, {});
const arm = (spec) => post(`${MOCKS}/_control/faults`, spec);
const tally = async (q = 'provider=whatsapp') => (await http(`${MOCKS}/_control/journal/tally?${q}`)).body;
const journal = async (q = '') => (await http(`${MOCKS}/_control/journal?${q}`)).body?.entries ?? [];
const odooState = async () => (await http(`${MOCKS}/_control/state/odoo`)).body;

// Ticks a set of consumers repeatedly. Queue work cascades — the pipeline enqueues
// Odoo work, Odoo enqueues a stage change — so one pass is rarely enough.
async function drain(kinds = ['pipeline', 'outbound', 'odoo', 'scheduler'], rounds = 4, gapMs = 700) {
  for (let i = 0; i < rounds; i++) {
    for (const k of kinds) await tick(k);
    await sleep(gapMs);
  }
}

async function reset() {
  psql(`TRUNCATE lead_source_event, work_queue, event_log, duplicate_decision,
        approval_request, dead_letter, idempotency_claim, lead RESTART IDENTITY CASCADE;
        UPDATE sales_rep SET available = true, open_leads = CASE rep_id
          WHEN 'rep_amara' THEN 2 WHEN 'rep_yuki' THEN 9
          WHEN 'rep_luis' THEN 3 WHEN 'rep_hana' THEN 6 ELSE 0 END;`);
  await post(`${MOCKS}/_control/reset`, {});
  await sleep(250);
}

// ---------------------------------------------------------------- fixtures
const STRONG = {
  name: 'Amara Okafor', email: 'amara.okafor@northwind-industrial.com', phone: '050 123 4567',
  company: 'Northwind Industrial', service: 'implementation', country: 'DE',
  budget: '100k-500k', timeline: 'immediate', consent: 'yes',
  message: 'Company-wide rollout across four sites, budget approved, CTO sponsor, urgent',
};
const MID = {
  name: 'Zenith Ops', email: 'ops@zenith-logistics.com', phone: '0501234321',
  company: 'Zenith Logistics', service: 'implementation', country: 'AE',
  budget: '100k-500k', timeline: 'this_quarter', consent: 'yes',
  message: 'We need an implementation partner this quarter, budget approved',
};
const WEAK = {
  name: 'Tim Kicker', email: 'tim@brightpath.co', phone: '0509998877',
  company: 'Brightpath', service: 'training', country: 'US', timeline: 'exploring', consent: 'yes',
  message: 'just browsing, no budget, student project',
};

// ---------------------------------------------------------------- the cases
const CASES = [
  {
    n: 1,
    title: 'The same lead arrives from WhatsApp and the website within 2 minutes',
    async run(t) {
      const web = await intake('website', STRONG);
      await tick('pipeline'); await sleep(500);
      const wa = await intake('whatsapp', {
        message_id: 'wamid.EC1', from: '+971 50 123 4567', profile_name: 'Amara Okafor',
        text: 'Following up on the form I just submitted', timestamp: new Date().toISOString(),
      });
      await tick('pipeline'); await sleep(500);
      await drain(['outbound', 'odoo'], 3);

      const leads = rows(`SELECT lead_id, source, dedup_status, duplicate_of, dedup_confidence FROM lead ORDER BY lead_id`);
      const merged = leads.find((l) => l.dedup_status === 'merged_into');
      const master = leads.find((l) => l.dedup_status === 'master');
      const dd = one(`SELECT tier, confidence, features->>'phone_exact' AS phone_exact,
                             features->>'cross_source' AS cross_source FROM duplicate_decision LIMIT 1`);
      const odoo = await odooState();
      const msgs = await tally();

      t.check('two source events produced two lead records', leads.length === 2);
      t.check('the pair was linked, not left separate', Boolean(merged && master),
        `master=${master?.lead_id} merged=${merged?.lead_id}`);
      t.check('auto-merge tier on a decisive identifier match',
        dd?.tier === 'auto_merge' && Number(dd.confidence) >= 0.9, `tier=${dd?.tier} conf=${dd?.confidence}`);
      t.check('cross-source was recorded as a supporting signal', dd?.cross_source === 'true');
      t.check('exactly one CRM record exists', odoo.leads.length === 1, `${odoo.leads.length} records`);
      t.check('the customer was messaged once, not twice', msgs.delivered === 1,
        `delivered=${msgs.delivered}`);
      t.check('the superseded record enqueued no downstream effects',
        Number(one(`SELECT count(*) AS c FROM work_queue WHERE lead_id = '${merged?.lead_id}'
                    AND kind IN ('odoo_sync','outbound')`)?.c ?? 0) === 0);
    },
  },

  {
    n: 2,
    title: 'A phone number is valid but submitted in two different formats',
    async run(t) {
      await intake('website', { ...MID, phone: '050 123 4321' });
      await intake('website', { ...MID, email: 'other@zenith-logistics.com', phone: '+971 50 123 4321' });
      await intake('website', { ...MID, email: 'third@zenith-logistics.com', phone: '00971501234321' });

      const forms = rows(`SELECT phone_raw, phone_e164, phone_valid FROM lead ORDER BY lead_id`);
      const distinct = new Set(forms.map((f) => f.phone_e164));

      t.check('all three submissions were accepted', forms.length === 3);
      t.check('every raw form parsed successfully', forms.every((f) => f.phone_valid));
      t.check('all three collapse to one E.164 value', distinct.size === 1, [...distinct].join(', '));
      t.check('the raw input is preserved alongside the normalised value',
        forms.every((f) => f.phone_raw && f.phone_raw !== f.phone_e164));
    },
  },

  {
    n: 3,
    title: 'The enrichment API times out twice, then succeeds',
    async run(t) {
      await arm({ id: 'ec3', provider: 'enrichment', mode: 'timeout', times: 2, delay_ms: 9000 });
      await intake('website', MID);

      for (let i = 0; i < 14; i++) {
        await tick('pipeline');
        const done = one(`SELECT enrichment->>'status' AS s FROM lead LIMIT 1`);
        if (done?.s === 'ok') break;
        await sleep(1500);
      }

      const lead = one(`SELECT enrichment->>'status' AS status, enrichment->>'attempts' AS attempts,
                               enrichment->'data'->>'company_size' AS size, score, disposition FROM lead LIMIT 1`);
      const defers = rows(`SELECT inputs->>'attempt' AS attempt FROM event_log
                           WHERE event_type = 'work.deferred' ORDER BY id`);

      t.check('the first two attempts were deferred, not failed outright', defers.length === 2,
        `deferrals: ${defers.map((d) => d.attempt).join(', ')}`);
      t.check('backoff attempts are numbered in order',
        defers.map((d) => Number(d.attempt)).join(',') === '1,2');
      t.check('the third attempt succeeded', lead?.status === 'ok', `status=${lead?.status}`);
      t.check('enrichment data was applied to the lead', Number(lead?.size) > 0, `company_size=${lead?.size}`);
      t.check('the lead was scored and routed normally afterwards',
        Number(lead?.score) > 0 && Boolean(lead?.disposition), `score=${lead?.score} -> ${lead?.disposition}`);
    },
  },

  {
    n: 4,
    title: 'The AI model returns an empty or malformed response',
    async run(t) {
      await arm({ id: 'ec4a', provider: 'llm', mode: 'malformed', times: 1 });
      await intake('website', { ...MID, email: 'malformed@zenith-logistics.com', phone: '0501110001' });
      await tick('pipeline'); await sleep(600);

      await arm({ id: 'ec4b', provider: 'llm', mode: 'empty', times: 1 });
      await intake('website', { ...MID, email: 'empty@zenith-logistics.com', phone: '0501110002' });
      await tick('pipeline'); await sleep(600);

      const leads = rows(`SELECT email_normalized,
                                 ai_classification->>'fallback_used' AS fallback,
                                 ai_classification->>'failure' AS failure,
                                 score, score_band, disposition, conflict_flag
                          FROM lead ORDER BY email_normalized`);

      t.check('both leads were still processed', leads.length === 2);
      t.check('both degraded to a declared fallback', leads.every((l) => l.fallback === 'true'));
      t.check('the malformed body is diagnosed precisely',
        leads.some((l) => l.failure === 'malformed_json'), leads.map((l) => l.failure).join(' / '));
      t.check('the empty body is diagnosed precisely',
        leads.some((l) => l.failure === 'empty_body'));
      t.check('scoring is unaffected — the AI never fed it',
        leads.every((l) => Number(l.score) > 0 && l.score_band));
      t.check('an unusable model response never manufactures a conflict',
        leads.every((l) => l.conflict_flag === false));
    },
  },

  {
    n: 5,
    title: "The AI says 'High Potential' but deterministic rules say low value",
    async run(t) {
      await arm({
        id: 'ec5', provider: 'llm', mode: 'respond', times: 1,
        body: { label: 'high_potential', confidence: 0.91, rationale: 'forced disagreement', model: 'mock-classifier-v1' },
      });
      await intake('website', WEAK);
      await tick('pipeline'); await sleep(600);

      const lead = one(`SELECT score, score_band, disposition, conflict_flag,
                               ai_classification->>'label' AS ai_label,
                               ai_classification->>'confidence' AS ai_conf FROM lead LIMIT 1`);
      const ev = one(`SELECT outputs->>'reason' AS reason, inputs->>'predicate_version' AS version
                      FROM event_log WHERE event_type = 'ai.conflict' LIMIT 1`);
      const queued = rows(`SELECT payload->>'slot' AS slot FROM work_queue WHERE kind = 'outbound'`)
        .map((r) => r.slot);

      t.check('rules scored the lead low', Number(lead?.score) < 40, `score=${lead?.score}`);
      t.check('the model disagreed confidently',
        lead?.ai_label === 'high_potential' && Number(lead?.ai_conf) >= 0.6);
      t.check('the disagreement was flagged as material', lead?.conflict_flag === true);
      t.check('the lead routed to manual review, overriding its band',
        lead?.disposition === 'manual_review', `disposition=${lead?.disposition}`);
      t.check('the reason is recorded with its predicate version',
        Boolean(ev?.reason) && Boolean(ev?.version), `${ev?.reason} (${ev?.version})`);
      // A transactional acknowledgement is not a sales action, so it still goes out.
      // Human review decides qualification, not whether to acknowledge receipt.
      t.check('no sales outreach was queued for a lead under review',
        !queued.some((s) => /^(sales_intro|followup)/.test(s ?? '')), queued.join(', ') || '(nothing queued)');
      t.check('the acknowledgement is still sent, as for any other lead',
        queued.includes('welcome'), queued.join(', ') || '(nothing queued)');
      t.check('no follow-up sequence was started for a lead under review',
        Number(one(`SELECT count(*) AS c FROM work_queue WHERE kind = 'followup'`)?.c ?? 0) === 0);
    },
  },

  {
    n: 6,
    title: 'The CRM API returns 429 Rate Limit',
    async run(t) {
      await arm({ id: 'ec6', provider: 'odoo', route: 'POST /odoo/leads', mode: 'status', status: 429,
        headers: { 'retry-after': '2' }, times: 1 });
      await intake('website', MID);
      await tick('pipeline'); await sleep(500);
      await drain(['odoo'], 6, 1200);

      const ev = rows(`SELECT event_type, decision, outputs->>'status' AS status,
                              outputs->>'reason' AS reason, outputs->>'retry_after_seconds' AS retry_after
                       FROM event_log WHERE step = 'odoo' ORDER BY id`);
      const failed = ev.find((e) => e.event_type === 'odoo.failed');
      const odoo = await odooState();
      const lead = one(`SELECT odoo_lead_id, odoo_stage FROM lead LIMIT 1`);

      t.check('the 429 was seen and classified as rate limiting',
        failed?.status === '429' && failed?.reason === 'rate_limited', JSON.stringify(failed ?? {}));
      t.check("the provider's Retry-After was honoured over our own backoff",
        Number(failed?.retry_after) === 2, `retry_after=${failed?.retry_after}s`);
      t.check('it was retried rather than dead-lettered', failed?.decision === 'retry');
      t.check('the record was eventually created exactly once', odoo.leads.length === 1);
      t.check('the lead was linked to its CRM record', Boolean(lead?.odoo_lead_id));
    },
  },

  {
    n: 7,
    title: 'The CRM create succeeds, but the workflow times out before confirmation',
    async run(t) {
      await arm({ id: 'ec7', provider: 'odoo', route: 'POST /odoo/leads', mode: 'drop_response', times: 1 });
      await intake('website', MID);
      await tick('pipeline'); await sleep(500);
      await drain(['odoo'], 6, 1200);

      const odoo = await odooState();
      const ev = rows(`SELECT event_type, decision, outputs->>'note' AS note FROM event_log
                       WHERE step = 'odoo' ORDER BY id`);
      const reconciled = ev.find((e) => e.event_type === 'odoo.reconciled');
      const lead = one(`SELECT odoo_lead_id, odoo_stage FROM lead LIMIT 1`);
      const claim = one(`SELECT state, provider_ref FROM idempotency_claim
                         WHERE effect_domain = 'odoo.lead.create' LIMIT 1`);

      t.check('exactly one CRM record exists despite the lost acknowledgement',
        odoo.leads.length === 1, `${odoo.leads.length} records`);
      t.check('the pipeline reconciled instead of guessing',
        reconciled?.decision === 'already_created', JSON.stringify(reconciled ?? {}));
      t.check('the audit says plainly what happened', /acknowledgement was lost/.test(reconciled?.note ?? ''));
      t.check('the existing record was adopted, not recreated',
        claim?.state === 'succeeded' && claim?.provider_ref === odoo.leads[0]?.id);
      t.check('the funnel still advanced afterwards', Boolean(lead?.odoo_stage), `stage=${lead?.odoo_stage}`);
    },
  },

  {
    n: 8,
    title: 'The WhatsApp send is retried after a transient error; no duplicate message',
    async run(t) {
      await arm({ id: 'ec8', provider: 'whatsapp', route: 'POST /whatsapp/messages',
        mode: 'status', status: 503, times: 1 });
      await intake('website', MID);
      await tick('pipeline'); await sleep(500);
      await drain(['outbound'], 6, 1200);

      const msgs = await tally();
      const sends = (await journal('provider=whatsapp')).filter((e) => e.method === 'POST');
      const claim = one(`SELECT state, attempt FROM idempotency_claim WHERE effect_domain = 'msg.send' LIMIT 1`);

      t.check('the provider was called twice', sends.length === 2, `${sends.length} POSTs`);
      t.check('the first call was rejected with the injected 503',
        sends[0]?.status === 503, `status=${sends[0]?.status}`);
      t.check('exactly one message was actually delivered', msgs.delivered === 1,
        `delivered=${msgs.delivered}`);
      t.check('the claim settled as succeeded', claim?.state === 'succeeded');
      t.check('the retry was counted rather than hidden', Number(claim?.attempt) >= 2,
        `attempt=${claim?.attempt}`);
    },
  },

  {
    n: 9,
    title: 'A salesperson is assigned, then becomes unavailable before follow-up',
    async run(t) {
      await intake('website', MID);
      await tick('pipeline'); await sleep(600);

      const before = one(`SELECT owner_id FROM lead LIMIT 1`);
      // Simulated elapsed time: the SLA window is 30 minutes and a test cannot wait it out.
      psql(`UPDATE sales_rep SET available = false WHERE rep_id = '${before.owner_id}';
            UPDATE lead SET assigned_at = now() - interval '40 minutes';
            UPDATE work_queue SET run_after = now() - interval '1 second' WHERE kind = 'sla_check';`);
      await tick('scheduler'); await sleep(800);

      const after = one(`SELECT owner_id, assignment_reason FROM lead LIMIT 1`);
      const ev = one(`SELECT inputs->>'owner_available' AS owner_available,
                             outputs->>'elapsed_minutes' AS elapsed,
                             outputs->>'escalated_to' AS escalated,
                             outputs->>'reassigned_to' AS reassigned
                      FROM event_log WHERE event_type = 'sla.breached' LIMIT 1`);
      const esc = one(`SELECT payload->>'to' AS recipient FROM work_queue
                       WHERE payload->>'slot' = 'sla_escalation' LIMIT 1`);
      const fresh = one(`SELECT count(*) AS c FROM work_queue WHERE kind = 'sla_check' AND state = 'pending'`);

      t.check('the breach was detected', Number(ev?.elapsed) >= 30, `${ev?.elapsed} minutes elapsed`);
      t.check('the owner was re-checked at dispatch, not trusted from assignment',
        ev?.owner_available === 'false');
      t.check('it escalated to a manager', Boolean(ev?.escalated) && Boolean(esc?.recipient),
        `${ev?.escalated} -> ${esc?.recipient}`);
      t.check('ownership actually moved, not just a logged recommendation',
        after?.owner_id !== before.owner_id && after?.owner_id === ev?.reassigned,
        `${before.owner_id} -> ${after?.owner_id}`);
      t.check('the reason records how the new owner was chosen',
        /SLA reassignment/.test(after?.assignment_reason ?? ''));
      t.check('the new owner starts on a fresh SLA clock', Number(fresh?.c) >= 1);
    },
  },

  {
    n: 10,
    title: 'A lead opts out while a delayed follow-up execution is already scheduled',
    async run(t) {
      await intake('website', MID);
      await tick('pipeline'); await sleep(600);
      await drain(['outbound'], 2);

      const scheduled = one(`SELECT count(*) AS c FROM work_queue WHERE kind = 'followup' AND state = 'pending'`);
      const beforeSends = (await tally()).delivered;

      psql(`UPDATE lead SET consent_status = 'withdrawn', consent_ts = now();
            UPDATE work_queue SET run_after = now() - interval '1 second' WHERE kind = 'followup';`);
      await tick('scheduler'); await sleep(700);
      await drain(['outbound'], 2);

      const ev = one(`SELECT decision, outputs->>'reason' AS reason FROM event_log
                      WHERE event_type = 'followup.stopped' LIMIT 1`);
      const after = await tally();
      const remaining = one(`SELECT count(*) AS c FROM work_queue WHERE kind = 'followup' AND state = 'pending'`);

      t.check('a follow-up was genuinely scheduled first', Number(scheduled?.c) >= 1);
      t.check('the sequence stopped when it came due', ev?.decision === 'stop');
      t.check('it stopped for the right reason', /consent withdrawn/.test(ev?.reason ?? ''), ev?.reason);
      t.check('no follow-up message was sent after the opt-out',
        after.delivered === beforeSends, `before=${beforeSends} after=${after.delivered}`);
      t.check('nothing was left queued to fire later', Number(remaining?.c) === 0);
    },
  },

  {
    n: 11,
    title: 'A meeting booking webhook is delivered twice',
    async run(t) {
      await intake('website', MID);
      await tick('pipeline'); await sleep(600);
      await drain(['outbound', 'odoo'], 3);
      const leadId = one(`SELECT lead_id FROM lead LIMIT 1`).lead_id;
      const beforeMsgs = (await tally()).delivered;

      const emit = await post(`${MOCKS}/_control/emit/booking`, {
        lead_id: leadId, booking_id: 'BK-EC11', times: 2, rep_email: 'amara@example.test',
      });
      const replies = (emit.body?.deliveries ?? []).map((d) => {
        try { return JSON.parse(d.body); } catch { return {}; }
      });
      await drain(['outbound', 'odoo'], 3);

      const lead = one(`SELECT status, status_reason FROM lead LIMIT 1`);
      const odoo = await odooState();
      const after = await tally();
      const cancelled = rows(`SELECT kind FROM work_queue WHERE state = 'cancelled'`);
      const applied = rows(`SELECT decision FROM event_log WHERE event_type = 'webhook.delivered' ORDER BY id`);

      t.check('the provider delivered twice', replies.length === 2);
      t.check('the first delivery applied', replies[0]?.applied === true);
      t.check('the second was recognised as a duplicate', replies[1]?.duplicate_delivery === true);
      t.check('the lead moved to booked exactly once', lead?.status === 'meeting_booked');
      t.check('the CRM shows one record reaching meeting_booked',
        odoo.leads.length === 1 && odoo.leads[0].stage === 'meeting_booked',
        odoo.leads[0]?.stage_history?.map((h) => h.stage).join(' -> '));
      t.check('marketing follow-up stopped', cancelled.some((c) => c.kind === 'followup'));
      t.check('the rep was notified once, not twice', after.delivered === beforeMsgs + 1,
        `before=${beforeMsgs} after=${after.delivered}`);
      t.check('both deliveries are visible in the audit, one suppressed',
        applied.length === 2 && applied[1].decision === 'duplicate_suppressed');
    },
  },

  {
    n: 12,
    title: 'A manager rejects a VIP lead after the automated qualification step',
    async run(t) {
      await intake('website', { ...STRONG, budget: '>1m' });
      await tick('pipeline'); await sleep(600);
      await drain(['outbound', 'odoo'], 3);

      const vip = one(`SELECT lead_id, vip_flag, approval_state, odoo_stage FROM lead LIMIT 1`);
      const token = one(`SELECT token FROM approval_request WHERE state = 'pending' LIMIT 1`)?.token;
      const beforeMsgs = await tally();
      const sentSlots = (await journal('provider=whatsapp'))
        .filter((e) => e.method === 'POST').map((e) => e.request?.template);

      const first = await post(`${N8N}/webhook/approval`, {
        token, lead_id: vip.lead_id, decision: 'reject', decided_by: 'mgr_dana',
        reason: 'not a strategic fit this quarter',
      });
      const second = await post(`${N8N}/webhook/approval`, {
        token, lead_id: vip.lead_id, decision: 'reject', decided_by: 'mgr_dana',
        reason: 'not a strategic fit this quarter',
      });
      await drain(['outbound', 'odoo'], 3);

      const after = one(`SELECT approval_state, disposition, status_reason FROM lead LIMIT 1`);
      const odoo = await odooState();
      const history = odoo.leads[0]?.stage_history ?? [];
      const rollback = history.find((h) => h.rollback);
      const afterMsgs = await tally();

      t.check('the lead was gated as VIP', vip?.vip_flag === true && vip?.approval_state === 'pending');
      t.check('the transactional acknowledgement was still sent',
        sentSlots.includes('welcome'), sentSlots.join(', ') || '(none)');
      t.check('no sales outreach was sent while approval was pending',
        !sentSlots.includes('sales_intro'));
      t.check('the rejection was applied once', first.body?.applied === true);
      t.check('a second click changed nothing', second.body?.duplicate_decision === true);
      t.check('the lead is recorded as rejected with a reason',
        after?.approval_state === 'rejected' && /not a strategic fit/.test(after?.status_reason ?? ''));
      t.check('the funnel rolled back explicitly, not silently',
        Boolean(rollback) && /vip_rejected/.test(rollback?.reason ?? ''),
        history.map((h) => h.stage).join(' -> '));
      t.check('no retraction message was sent to the customer',
        afterMsgs.delivered === beforeMsgs.delivered,
        `before=${beforeMsgs.delivered} after=${afterMsgs.delivered}`);
    },
  },

  {
    n: 13,
    title: 'A corrupted CSV row is included in a batch of otherwise valid records',
    async run(t) {
      const csv = [
        'name,email,phone,service,notes',
        'Amara Okafor,amara@northwind-industrial.com,0501234567,implementation,Company-wide rollout across four sites',
        'Broken Row,missing-columns',
        'Yuki Tanaka,yuki@tanaka-mfg.co.jp,+818012345678,consulting,Exploring options for next year',
        'Quoted Fine,"quoted@lumen-health.io","+44 7700 900123",training,"Said ""yes"" on the call"',
        'Bad Quote,we"ird@example.com,+971501112222,support,stray quote in field',
      ].join('\n');

      const res = await post(`${N8N}/webhook/intake/csv`, { batch_ref: 'evidence-batch.csv', csv });
      await tick('pipeline'); await sleep(800);

      const body = res.body ?? {};
      const leads = rows(`SELECT full_name, score, disposition FROM lead ORDER BY full_name`);
      const dlq = rows(`SELECT payload->>'line' AS line, error->>'code' AS code, resolution FROM dead_letter ORDER BY id`);

      t.check('the batch was accepted rather than rejected wholesale', res.status === 202);
      t.check('all five rows were seen', body.rows_seen === 5);
      t.check('the three valid rows imported', body.rows_imported === 3, `imported=${body.rows_imported}`);
      t.check('the two corrupt rows were quarantined', body.rows_quarantined === 2);
      t.check('each rejection names its line and its fault',
        dlq.length === 2 && dlq.every((d) => d.line && d.code),
        dlq.map((d) => `line ${d.line}: ${d.code}`).join('; '));
      t.check('the good rows went all the way through scoring',
        leads.length === 3 && leads.every((l) => l.score !== null && l.disposition));
      t.check('quarantined rows wait for a human rather than being retried',
        dlq.every((d) => d.resolution === 'open'));

      // Re-importing the same file must not duplicate anything.
      const again = await post(`${N8N}/webhook/intake/csv`, { batch_ref: 'evidence-batch.csv', csv });
      t.check('re-importing the identical file imports nothing new',
        again.body?.rows_imported === 0 && again.body?.rows_already_present === 3);
      t.check('and does not queue the same broken rows again',
        Number(one(`SELECT count(*) AS c FROM dead_letter`)?.c) === 2);
    },
  },

  {
    n: 14,
    title: 'A workflow execution is manually re-run after partial success',
    async run(t) {
      // Part one: replaying work that already succeeded must be a no-op.
      await intake('website', MID);
      await tick('pipeline'); await sleep(600);
      await drain(['outbound', 'odoo'], 4);

      const leadId = one(`SELECT lead_id FROM lead LIMIT 1`).lead_id;
      const firstMsgs = await tally();
      const firstOdoo = await odooState();

      psql(`INSERT INTO work_queue (kind, lead_id, payload, idempotency_key) VALUES
        ('outbound','${leadId}','{"slot":"welcome","channel":"whatsapp"}','v1:msg.send:lead:${leadId}:welcome'),
        ('odoo_sync','${leadId}','{"action":"create_or_update"}','v1:odoo.lead.create:lead:${leadId}:1');`);
      await drain(['outbound', 'odoo'], 3);

      const replayMsgs = await tally();
      const replayOdoo = await odooState();
      const skips = rows(`SELECT event_type, inputs->>'reason' AS reason FROM event_log
                          WHERE event_type IN ('message.skip','odoo.skipped') ORDER BY id`);

      t.check('replaying a delivered message sends nothing further',
        replayMsgs.delivered === firstMsgs.delivered,
        `before=${firstMsgs.delivered} after=${replayMsgs.delivered}`);
      t.check('replaying a created CRM record creates nothing further',
        replayOdoo.leads.length === firstOdoo.leads.length);
      t.check('each skip explains itself against the claim',
        skips.length >= 2 && skips.every((s) => /already/.test(s.reason ?? '')),
        skips.map((s) => s.reason).join(' | '));

      // Part two: a permanently failed effect can be deliberately replayed.
      await arm({ id: 'ec14', provider: 'whatsapp', route: 'POST /whatsapp/messages',
        mode: 'status', status: 400, times: 1 });
      psql(`INSERT INTO work_queue (kind, lead_id, payload, idempotency_key) VALUES
        ('outbound','${leadId}','{"slot":"followup.1","channel":"whatsapp"}','v1:msg.send:lead:${leadId}:followup.1');`);
      await drain(['outbound'], 3);

      const dead = one(`SELECT id, resolution FROM dead_letter WHERE idempotency_key LIKE '%followup.1' LIMIT 1`);
      const failedClaim = one(`SELECT state FROM idempotency_claim WHERE key LIKE '%followup.1' LIMIT 1`);

      const replay = await post(`${N8N}/webhook/ops/dlq/replay`, {});
      await drain(['outbound'], 3);

      const finalClaim = one(`SELECT state FROM idempotency_claim WHERE key LIKE '%followup.1' LIMIT 1`);
      const finalDlq = one(`SELECT resolution FROM dead_letter WHERE id = ${dead?.id ?? 0}`);
      const finalMsgs = await tally();

      t.check('a permanent failure was dead-lettered', dead?.resolution === 'open');
      t.check('its claim was marked failed rather than succeeded',
        failedClaim?.state === 'failed_permanent');
      t.check('the operator replay cleared only the failed claim',
        replay.body?.claims_cleared === 1 && replay.body?.requeued === 1);
      t.check('the effect then completed', finalClaim?.state === 'succeeded');
      t.check('the dead letter is marked replayed', finalDlq?.resolution === 'replayed');
      t.check('and the previously delivered message was still not re-sent',
        finalMsgs.delivered === replayMsgs.delivered + 1,
        `expected exactly one new send, got ${finalMsgs.delivered - replayMsgs.delivered}`);
    },
  },
];

// ---------------------------------------------------------------- runner
const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const selected = only.length ? CASES.filter((c) => only.includes(c.n)) : CASES;

const report = [];
let passed = 0, failed = 0;

console.log(`\nMandatory edge cases — ${selected.length} scenario(s) against ${N8N}\n${'='.repeat(78)}`);

for (const c of selected) {
  await reset();
  const checks = [];
  const t = { check: (label, ok, detail = '') => checks.push({ label, ok: Boolean(ok), detail: String(detail) }) };

  let crash = null;
  try {
    await c.run(t);
  } catch (e) {
    crash = e.message;
    checks.push({ label: 'scenario ran to completion', ok: false, detail: e.message });
  }

  const ok = checks.length > 0 && checks.every((x) => x.ok);
  ok ? passed++ : failed++;

  console.log(`\n${ok ? 'PASS' : 'FAIL'}  Case ${c.n}: ${c.title}`);
  for (const x of checks) {
    console.log(`      ${x.ok ? '+' : '!'} ${x.label}${x.detail ? `  [${x.detail}]` : ''}`);
  }
  report.push({ n: c.n, title: c.title, ok, checks, crash });
}

console.log(`\n${'='.repeat(78)}`);
console.log(`${passed} of ${selected.length} cases passed${failed ? `, ${failed} FAILED` : ''}\n`);

// Markdown transcript, so evidence can be read without re-running anything.
const md = [
  '# Test evidence — mandatory edge cases',
  '',
  `Generated by \`node 05_Test_Evidence/run-edge-cases.mjs\` against the running stack.`,
  '',
  `**${passed} of ${selected.length} cases passed.**`,
  '',
  'Each case resets the database and mock harness first, so cases are independent.',
  'Assertions are made against external observations — the provider call journal, the',
  'CRM mock record count — rather than against what the pipeline reports about itself.',
  '',
  '| # | Case | Result |',
  '|---|---|---|',
  ...report.map((r) => `| ${r.n} | ${r.title} | ${r.ok ? 'PASS' : 'FAIL'} |`),
  '',
  '---',
  '',
  ...report.flatMap((r) => [
    `## Case ${r.n} — ${r.title}`,
    '',
    `**${r.ok ? 'PASS' : 'FAIL'}**`,
    '',
    ...r.checks.map((c) => `- ${c.ok ? '**pass**' : '**FAIL**'} — ${c.label}${c.detail ? ` \`${c.detail}\`` : ''}`),
    ...(r.crash ? ['', `> scenario threw: \`${r.crash}\``] : []),
    '',
  ]),
].join('\n');

writeFileSync(join(ROOT, '05_Test_Evidence', 'RESULTS.md'), md);
console.log(`transcript written to 05_Test_Evidence/RESULTS.md`);

process.exit(failed ? 1 : 0);
