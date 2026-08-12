import { Router } from 'express';
import * as faults from './faults.js';
import * as journal from './journal.js';
import * as odoo from './providers/odoo.js';
import * as whatsapp from './providers/whatsapp.js';
import * as booking from './providers/booking.js';

const N8N_BASE_URL = process.env.N8N_BASE_URL ?? 'http://n8n:5678';

export const router = Router();

router.post('/faults', (req, res) => {
  const specs = Array.isArray(req.body) ? req.body : [req.body];
  try {
    res.status(201).json({ armed: specs.map(faults.arm) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/faults', (_req, res) => res.json({ armed: faults.list() }));
router.delete('/faults/:id', (req, res) => res.json({ disarmed: faults.disarm(req.params.id) }));
router.delete('/faults', (_req, res) => { faults.reset(); res.json({ disarmed: 'all' }); });

router.get('/journal', (req, res) => res.json({ entries: journal.query(req.query) }));
router.get('/journal/tally', (req, res) => res.json(journal.tally(req.query)));
router.delete('/journal', (_req, res) => { journal.reset(); res.json({ cleared: true }); });

router.get('/state/:provider', (req, res) => {
  const dumps = { odoo: odoo.dump, whatsapp: whatsapp.dump, booking: booking.dump };
  const fn = dumps[req.params.provider];
  if (!fn) return res.status(404).json({ error: 'unknown_provider', known: Object.keys(dumps) });
  res.json(fn());
});

// Full reset between test scenarios. Keeps evidence runs independent of each other.
router.post('/reset', (_req, res) => {
  faults.reset();
  journal.reset();
  odoo.reset();
  whatsapp.reset();
  booking.reset();
  res.json({ reset: ['faults', 'journal', 'odoo', 'whatsapp', 'booking'] });
});

async function deliver(path, body, times) {
  const url = `${N8N_BASE_URL}${path}`;
  const results = [];
  for (let i = 1; i <= times; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      results.push({ delivery: i, status: r.status, body: await r.text().catch(() => null) });
    } catch (err) {
      results.push({ delivery: i, error: err.message });
    }
  }
  return { url, deliveries: results };
}

// Drives inbound webhooks *into* n8n. The `times` parameter is the whole point:
// edge case 11 is a booking webhook delivered twice, and a redelivery has to be
// byte-identical to the original to be a fair test.
router.post('/emit/booking', async (req, res) => {
  const { lead_id, booking_id, starts_at, rep_id, times = 1, path = '/webhook/booking' } = req.body ?? {};
  const created = booking.create({ lead_id, booking_id, starts_at, rep_id });
  const payload = { event: 'booking.created', ...created };
  res.json({ booking: created, ...(await deliver(path, payload, times)) });
});

router.post('/emit', async (req, res) => {
  const { path, body = {}, times = 1 } = req.body ?? {};
  if (!path) return res.status(400).json({ error: 'path required' });
  res.json(await deliver(path, body, times));
});
