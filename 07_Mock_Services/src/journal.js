// Every inbound call, recorded. This is the test oracle: edge case 8 is proven by
// asserting the WhatsApp provider saw exactly one *delivery* across two workflow
// attempts. That is an outside observation, rather than the pipeline grading its own work.

const CAP = 5000;
const entries = [];
let seq = 0;

export function open({ provider, method, path, query, headers, body }) {
  const entry = {
    seq: ++seq,
    ts: new Date().toISOString(),
    provider,
    method,
    path,
    query,
    idempotency_key: headers['idempotency-key'] ?? null,
    request: body ?? null,
    status: null,
    fault: null,
    outcome: null,     // providers stamp 'delivered' | 'replayed' | 'rejected' here
    duration_ms: null,
  };
  entries.push(entry);
  if (entries.length > CAP) entries.splice(0, entries.length - CAP);
  return entry;
}

export function query_({ provider, idempotency_key, path, outcome, since_seq } = {}) {
  return entries.filter((e) =>
    (!provider || e.provider === provider) &&
    (!idempotency_key || e.idempotency_key === idempotency_key) &&
    (!path || e.path.startsWith(path)) &&
    (!outcome || e.outcome === outcome) &&
    (!since_seq || e.seq > Number(since_seq)));
}

// The assertion most tests actually want: how many times did a real effect land?
export function tally({ provider, idempotency_key, path } = {}) {
  const rows = query_({ provider, idempotency_key, path });
  const by = (o) => rows.filter((r) => r.outcome === o).length;
  return {
    calls: rows.length,
    delivered: by('delivered'),
    replayed: by('replayed'),
    lookups: by('lookup'),
    rejected: by('rejected'),
    faulted: rows.filter((r) => r.fault).length,
  };
}

export function reset() {
  entries.length = 0;
  seq = 0;
}

export { query_ as query };
