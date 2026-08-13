import { Router } from 'express';

const messages = new Map();  // message id -> record
const byKey = new Map();     // idempotency key -> message id
let nextId = 5000;

export const reset = () => { messages.clear(); byKey.clear(); nextId = 5000; };
export const dump = () => ({ messages: [...messages.values()] });

export const router = Router();

// Same reconciliation contract as Odoo. Real WhatsApp BSPs vary: some accept a
// client message id, some don't. Where they don't, the honest fallback is
// at-most-once — a missing message beats a duplicate one.
router.get('/messages/lookup', (req, res) => {
  // Labelled explicitly: a reconciliation read is not a delivery. The journal is
  // used as a test oracle for exactly-once, so counting a lookup as a send would
  // quietly invalidate that evidence.
  res.locals.journal.outcome = 'lookup';
  const id = byKey.get(req.query.idempotency_key);
  if (!id) return res.status(404).json({ found: false });
  res.json({ found: true, message: messages.get(id) });
});

router.post('/messages', (req, res) => {
  const key = req.headers['idempotency-key'];
  if (!key) return res.status(400).json({ error: 'Idempotency-Key header required' });

  const { to, channel = 'whatsapp', template, body } = req.body ?? {};
  if (!to) return res.status(400).json({ error: 'recipient "to" required' });

  if (byKey.has(key)) {
    const existing = messages.get(byKey.get(key));
    res.locals.journal.outcome = 'replayed';
    return res.status(200).json({ ...existing, replayed: true });
  }

  const id = `wamid-${nextId++}`;
  const record = {
    message_id: id,
    idempotency_key: key,
    to, channel, template, body,
    status: 'sent',
    sent_at: new Date().toISOString(),
    replayed: false,
  };
  messages.set(id, record);
  byKey.set(key, id);
  res.locals.journal.outcome = 'delivered';
  res.status(201).json(record);
});

router.get('/messages/:id', (req, res) => {
  const m = messages.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  res.json(m);
});
