import { Router } from 'express';

// Funnel stages carry a rank so the writer can refuse to move a lead backwards.
// won and lost share the top rank: both are exits, and leaving either one is a
// reopen, which should be as deliberate as any other rollback.
export const STAGES = {
  new: 10,
  contacted: 20,
  qualified: 30,
  proposition: 40,
  meeting_booked: 50,
  won: 100,
  lost: 100,
};

const leads = new Map();   // odoo id -> record
const byKey = new Map();   // idempotency key -> odoo id
let nextId = 1000;

export const reset = () => { leads.clear(); byKey.clear(); nextId = 1000; };
export const dump = () => ({ leads: [...leads.values()], keys: [...byKey.entries()] });

export const router = Router();

// Reconciliation endpoint. This is the one thing the whole recovery story depends on:
// after a lost ack we need to ask "did effect K land?" rather than guess. Real Odoo
// has no equivalent — see the known-limitations section.
router.get('/leads/lookup', (req, res) => {
  // A reconciliation read is not a write. See the note in whatsapp.js.
  res.locals.journal.outcome = 'lookup';
  const id = byKey.get(req.query.idempotency_key);
  if (!id) return res.status(404).json({ found: false });
  res.json({ found: true, lead: leads.get(id) });
});

router.post('/leads', (req, res) => {
  const key = req.headers['idempotency-key'];
  if (!key) return res.status(400).json({ error: 'Idempotency-Key header required' });

  if (byKey.has(key)) {
    res.locals.journal.outcome = 'replayed';
    return res.status(200).json({ ...leads.get(byKey.get(key)), replayed: true });
  }

  const id = `odoo-lead-${nextId++}`;
  const now = new Date().toISOString();
  const lead = {
    id,
    idempotency_key: key,
    ...req.body,
    stage: 'new',
    stage_rank: STAGES.new,
    stage_history: [{ stage: 'new', at: now, reason: 'created' }],
    created_at: now,
    updated_at: now,
    replayed: false,
  };
  leads.set(id, lead);
  byKey.set(key, id);
  res.locals.journal.outcome = 'delivered';
  res.status(201).json(lead);
});

router.get('/leads/:id', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not_found' });
  res.json(lead);
});

router.patch('/leads/:id', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not_found' });
  Object.assign(lead, req.body, { updated_at: new Date().toISOString() });
  res.locals.journal.outcome = 'delivered';
  res.json(lead);
});

router.post('/leads/:id/stage', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not_found' });

  const { stage, rollback_reason } = req.body ?? {};
  const rank = STAGES[stage];
  if (rank === undefined) {
    return res.status(400).json({ error: 'unknown_stage', stage, known: Object.keys(STAGES) });
  }

  // Setting the stage a lead is already in is a no-op, not a conflict. Stage writes
  // have to be safely repeatable or every retry becomes a 409.
  if (lead.stage === stage) {
    res.locals.journal.outcome = 'replayed';
    return res.json({ ...lead, changed: false });
  }

  if (rank <= lead.stage_rank && !rollback_reason) {
    res.locals.journal.outcome = 'rejected';
    return res.status(409).json({
      error: 'stage_regression_refused',
      current: lead.stage,
      current_rank: lead.stage_rank,
      requested: stage,
      requested_rank: rank,
      hint: 'supply rollback_reason to move a lead backwards deliberately',
    });
  }

  const now = new Date().toISOString();
  lead.stage_history.push({
    stage, at: now, from: lead.stage,
    reason: rollback_reason ?? req.body.reason ?? 'advance',
    rollback: Boolean(rollback_reason),
  });
  lead.stage = stage;
  lead.stage_rank = rank;
  lead.updated_at = now;
  res.locals.journal.outcome = 'delivered';
  res.json({ ...lead, changed: true });
});
