import express from 'express';
import pg from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only over the pipeline's own tables, plus proxies to the workflows that own
// the three human checkpoints. The console never writes application state itself —
// every button drives the real webhook, so what an operator does here is
// indistinguishable from what a provider or a script does.

const PORT = Number(process.env.PORT ?? 8090);
const N8N = process.env.N8N_BASE_URL ?? 'http://n8n:5678';
const MOCKS = process.env.MOCKS_BASE_URL ?? 'http://mocks:8080';

const pool = new pg.Pool({
  host: process.env.PGHOST ?? 'postgres',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'leadops',
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 5,
});

const app = express();
app.use(express.json());
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), 'public')));

const q = (text, params = []) => pool.query(text, params).then((r) => r.rows);
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[console]', e.message);
  res.status(500).json({ error: e.message });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'leadops-console' }));

app.get('/api/summary', wrap(async (_req, res) => {
  const [summary] = await q('SELECT * FROM ops_summary');
  res.json(summary ?? {});
}));

app.get('/api/leads', wrap(async (_req, res) => {
  res.json(await q(`
    SELECT l.lead_id, l.full_name, l.source, l.score, l.score_band, l.disposition,
           l.owner_id, l.vip_flag, l.approval_state, l.dedup_status, l.duplicate_of,
           l.conflict_flag, l.status, l.odoo_stage, l.consent_status,
           l.ingested_at
    FROM lead l ORDER BY l.ingested_at DESC LIMIT 200`));
}));

app.get('/api/leads/:id', wrap(async (req, res) => {
  const id = req.params.id;
  const [lead] = await q('SELECT * FROM lead WHERE lead_id = $1', [id]);
  if (!lead) return res.status(404).json({ error: 'not_found' });

  const [timeline, dupes, effects] = await Promise.all([
    q(`SELECT ts, entry_kind, label, detail, severity, inputs, outputs
       FROM lead_timeline WHERE lead_id = $1 ORDER BY ts, seq NULLS LAST, label`, [id]),
    q(`SELECT candidate_lead_id, confidence, tier, action_taken, demoted_reason, features
       FROM duplicate_decision WHERE lead_id = $1 ORDER BY confidence DESC`, [id]),
    q(`SELECT key, effect_domain, occurrence, state, attempt, provider_ref, settled_at
       FROM idempotency_claim WHERE entity_id = $1 ORDER BY created_at`, [id]),
  ]);
  res.json({ lead, timeline, dupes, effects });
}));

app.get('/api/approvals', wrap(async (_req, res) => {
  res.json(await q(`
    SELECT a.id, a.lead_id, a.token, a.state, a.requested_at, a.expires_at,
           l.full_name, l.company, l.score, l.owner_id, l.status_reason
    FROM approval_request a JOIN lead l ON l.lead_id = a.lead_id
    WHERE a.state = 'pending' ORDER BY a.requested_at`));
}));

app.get('/api/review', wrap(async (_req, res) => {
  res.json(await q(`
    SELECT lead_id, full_name, company, score, score_band, disposition, conflict_flag,
           dedup_status, dedup_confidence, status_reason
    FROM lead
    WHERE disposition IN ('manual_review','data_completion') OR dedup_status = 'pending_review'
    ORDER BY ingested_at DESC LIMIT 50`));
}));

app.get('/api/dlq', wrap(async (_req, res) => {
  res.json(await q(`
    SELECT id, origin_kind, lead_id, idempotency_key, error, payload, failed_at, resolution
    FROM dead_letter WHERE resolution = 'open' ORDER BY failed_at DESC LIMIT 50`));
}));

app.get('/api/journal', wrap(async (_req, res) => {
  const r = await fetch(`${MOCKS}/_control/journal`);
  const j = await r.json();
  res.json((j.entries ?? []).slice(-40).reverse());
}));

// --- the three human checkpoints -------------------------------------------
// Each posts to the workflow that owns the decision. The console has no authority
// of its own: idempotency, compensation and audit all happen where they already do.

const toN8n = async (path, body) => {
  const r = await fetch(`${N8N}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; }
  catch { return { status: r.status, body: text }; }
};

app.post('/api/approvals/decide', wrap(async (req, res) => {
  const { token, lead_id, decision, reason } = req.body ?? {};
  const out = await toN8n('/webhook/approval', {
    token, lead_id, decision, decided_by: req.body.decided_by ?? 'console-operator',
    reason: reason ?? (decision === 'reject' ? 'rejected from operator console' : 'approved from operator console'),
  });
  res.status(out.status).json(out.body);
}));

app.post('/api/dlq/replay', wrap(async (req, res) => {
  const out = await toN8n('/webhook/ops/dlq/replay', { ids: req.body?.ids ?? null });
  res.status(out.status).json(out.body);
}));

// Convenience for demos: the consumers run on a one-minute schedule anyway, this
// just avoids waiting for the next tick while someone is watching.
app.post('/api/tick/:what', wrap(async (req, res) => {
  const allowed = ['pipeline', 'outbound', 'odoo', 'scheduler'];
  if (!allowed.includes(req.params.what)) return res.status(400).json({ error: 'unknown consumer' });
  const out = await toN8n(`/webhook/ops/tick/${req.params.what}`, {});
  res.status(200).json({ consumer: req.params.what, result: out.body });
}));

app.listen(PORT, '0.0.0.0', () => console.log(`[console] listening on ${PORT}`));
