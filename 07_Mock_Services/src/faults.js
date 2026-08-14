import { randomUUID } from 'node:crypto';

// Faults are armed deliberately and matched per request. Nothing here is random:
// edge case 3 says "times out twice, then succeeds", which is a scripted sequence a
// reviewer has to be able to reproduce on demand, not wait around for.

const armed = new Map();

const MODES = new Set(['timeout', 'slow', 'status', 'reset', 'malformed', 'empty', 'respond', 'drop_response']);

export function arm(spec) {
  if (!MODES.has(spec.mode)) {
    throw new Error(`unknown fault mode "${spec.mode}" (expected one of ${[...MODES].join(', ')})`);
  }
  const id = spec.id ?? `flt_${randomUUID().slice(0, 8)}`;
  const fault = {
    id,
    provider: spec.provider ?? null,
    route: spec.route ?? null,        // "POST /odoo/leads", or a bare path prefix
    match: spec.match ?? null,        // {idempotency_key} | {"query.email"} | {"body.lead_id"} | {"header.x-foo"}
    mode: spec.mode,
    status: spec.status ?? 500,
    headers: spec.headers ?? {},
    body: spec.body ?? null,
    delay_ms: spec.delay_ms ?? 0,
    times: spec.times ?? 0,           // 0 means "until disarmed"
    consumed: 0,
    note: spec.note ?? null,
    armed_at: new Date().toISOString(),
  };
  armed.set(id, fault);
  return fault;
}

export const list = () => [...armed.values()];
export const disarm = (id) => armed.delete(id);
export const reset = () => armed.clear();

const dig = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

function matches(fault, ctx) {
  if (fault.provider && fault.provider !== ctx.provider) return false;

  if (fault.route) {
    const hasVerb = /\s/.test(fault.route.trim());
    const [verb, prefix] = hasVerb ? fault.route.trim().split(/\s+/) : [null, fault.route];
    if (verb && verb.toUpperCase() !== ctx.method) return false;
    if (!ctx.path.startsWith(prefix)) return false;
  }

  for (const [key, expected] of Object.entries(fault.match ?? {})) {
    let actual;
    if (key === 'idempotency_key') actual = ctx.idempotencyKey;
    else if (key.startsWith('query.')) actual = ctx.query[key.slice(6)];
    else if (key.startsWith('header.')) actual = ctx.headers[key.slice(7).toLowerCase()];
    else if (key.startsWith('body.')) actual = dig(ctx.body, key.slice(5));
    else actual = dig(ctx.body, key);
    if (String(actual) !== String(expected)) return false;
  }
  return true;
}

// One-shot directives ride on the request itself, which keeps single-request tests
// from having to arm and disarm around every call.
function inlineDirective(ctx) {
  const raw = ctx.headers['x-fault-directive'];
  if (!raw) return null;
  try {
    return { ...JSON.parse(raw), id: 'inline', times: 1, consumed: 0 };
  } catch {
    return null;
  }
}

export function select(ctx) {
  const inline = inlineDirective(ctx);
  if (inline) return inline;

  for (const fault of armed.values()) {
    if (fault.times && fault.consumed >= fault.times) continue;
    if (!matches(fault, ctx)) continue;
    fault.consumed += 1;
    return fault;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns true when the fault has taken over the response, false to fall through
// to the real handler (which is what 'slow' wants, since it delays a success rather than causing a failure).
export async function apply(fault, _req, res) {
  switch (fault.mode) {
    case 'drop_response': {
      // The effect lands, the acknowledgement does not. This is the only honest way
      // to reproduce edge case 7: the handler runs and mutates state, then the
      // socket dies before the client learns anything. Distinct from 'timeout',
      // which never reaches the handler at all.
      const kill = () => { try { res.socket?.destroy(); } catch { /* already gone */ } };
      res.json = function () { if (res.locals.journal) res.locals.journal.outcome ??= 'delivered'; kill(); return res; };
      res.send = function () { kill(); return res; };
      return false;
    }

    case 'reset':
      // Socket death rather than an HTTP status: this is the "service is down"
      // error class, ECONNRESET, which travels a different code path than a 503.
      res.socket?.destroy();
      return true;

    case 'timeout':
      // Deliberately never responds. The client's own timeout is what fires.
      setTimeout(() => { try { res.socket?.destroy(); } catch { /* already gone */ } },
        fault.delay_ms || 120_000);
      return true;

    case 'slow':
      await sleep(fault.delay_ms || 1000);
      return false;

    case 'malformed':
      res.status(200).type('application/json').send('{"label":"high_potential","confid');
      return true;

    case 'empty':
      res.status(200).type('application/json').send('');
      return true;

    case 'status':
      res.set(fault.headers).status(fault.status)
        .json(fault.body ?? { error: 'injected_fault', status: fault.status, fault_id: fault.id });
      return true;

    case 'respond':
      // Not a failure at all, but a forced *valid* response. Edge case 5 needs the AI to
      // confidently disagree with the rules, which is behaviour, not breakage.
      res.set(fault.headers).status(fault.status === 500 ? 200 : fault.status)
        .json(fault.body ?? {});
      return true;

    default:
      return false;
  }
}
