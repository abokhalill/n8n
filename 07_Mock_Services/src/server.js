import express from 'express';
import * as faults from './faults.js';
import * as journal from './journal.js';
import { router as control } from './control.js';
import { router as odoo } from './providers/odoo.js';
import { router as whatsapp } from './providers/whatsapp.js';
import { router as enrichment } from './providers/enrichment.js';
import { router as llm } from './providers/llm.js';
import { router as booking } from './providers/booking.js';

const PORT = Number(process.env.PORT ?? 8080);

const PROVIDER_BY_PREFIX = [
  ['/odoo', 'odoo'],
  ['/whatsapp', 'whatsapp'],
  ['/enrich', 'enrichment'],
  ['/ai', 'llm'],
  ['/booking', 'booking'],
];

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'leadops-mocks' }));

// Everything below runs for provider routes only; the control plane must stay
// reachable even while a provider is armed to fail.
app.use((req, res, next) => {
  const hit = PROVIDER_BY_PREFIX.find(([prefix]) => req.path.startsWith(prefix));
  if (!hit) return next();

  const started = Date.now();
  const entry = journal.open({
    provider: hit[1],
    method: req.method,
    path: req.path,
    query: req.query,
    headers: req.headers,
    body: req.body,
  });
  res.locals.journal = entry;

  const close = () => {
    entry.status = res.statusCode;
    entry.duration_ms = Date.now() - started;
    if (entry.outcome === null) entry.outcome = res.statusCode < 400 ? 'delivered' : 'rejected';
  };
  res.on('finish', close);
  res.on('close', () => { if (entry.status === null) { entry.outcome = 'aborted'; close(); } });

  const ctx = {
    provider: hit[1],
    method: req.method,
    path: req.path,
    query: req.query,
    headers: req.headers,
    body: req.body,
    idempotencyKey: req.headers['idempotency-key'] ?? null,
  };

  const fault = faults.select(ctx);
  if (!fault) return next();

  entry.fault = { id: fault.id, mode: fault.mode, status: fault.status };
  faults.apply(fault, req, res).then((handled) => { if (!handled) next(); });
});

app.use('/_control', control);
app.use('/odoo', odoo);
app.use('/whatsapp', whatsapp);
app.use('/enrich', enrichment);
app.use('/ai', llm);
app.use('/booking', booking);

app.use((err, _req, res, _next) => {
  console.error('[mocks] unhandled', err);
  res.status(500).json({ error: 'mock_internal_error', detail: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[mocks] listening on ${PORT} -> odoo, whatsapp, enrichment, llm, booking`);
  console.log(`[mocks] control plane at /_control (faults, journal, state, emit)`);
});
