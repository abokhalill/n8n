import { canonicalJson, sha256 } from './ids.mjs';

// A key names an *effect*, not an attempt. Two tries at the same effect collide;
// two different effects never do. Nothing that varies between retries may appear
// here — no execution id, no timestamp, no attempt counter — because replay safety
// (edge case 14) is a consequence of that purity rather than a separate mechanism.

export const KEY_VERSION = 'v1';

export function effectKey({ domain, entityType = 'lead', entityId, occurrence = '1' }) {
  if (!domain || !entityId) throw new Error('effectKey needs domain and entityId');
  for (const part of [domain, entityType, entityId, occurrence]) {
    if (String(part).includes(':')) throw new Error(`key part "${part}" must not contain ':'`);
  }
  return `${KEY_VERSION}:${domain}:${entityType}:${entityId}:${occurrence}`;
}

export function parseEffectKey(key) {
  const [version, domain, entityType, entityId, ...rest] = String(key).split(':');
  return { version, domain, entityType, entityId, occurrence: rest.join(':') };
}

// The link the whole chain hangs on. If a redelivered webhook minted a fresh
// lead_id, every downstream key would differ and every effect would fire twice.
// Prefer the provider's own event id; fall back to a content hash.
export function sourceEventKey({ source, providerEventId, payload }) {
  if (!source) throw new Error('sourceEventKey needs a source');
  if (providerEventId) return `${source}:id:${providerEventId}`;
  return `${source}:sha256:${sha256(canonicalJson(payload ?? {}))}`;
}

// Detects a key reused with genuinely different content, which is a bug in the
// caller rather than a retry, and should be surfaced instead of silently deduped.
export const requestFingerprint = (body) => sha256(canonicalJson(body ?? {}));

// Full jitter. Decorrelates retry storms harder than equal jitter, and the worst
// case is an early retry rather than a synchronised thundering herd.
export function nextBackoffMs(attempt, { baseMs = 2000, capMs = 900_000, random = Math.random } = {}) {
  const ceiling = Math.min(baseMs * 2 ** attempt, capMs);
  return Math.floor(random() * ceiling);
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSPORT_ERRORS = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|aborted/i;

// Classify before scheduling. Burning five attempts on a 401 is slow and useless,
// and brief section I calls out missing credentials as its own case.
export function classifyFailure({ status, code, message } = {}) {
  if (status === 401 || status === 403) {
    return { retryable: false, reason: 'auth', detail: 'credentials rejected — retrying cannot help' };
  }
  if (status && RETRYABLE_STATUS.has(status)) {
    return { retryable: true, reason: status === 429 ? 'rate_limited' : 'transient_server' };
  }
  if (status && status >= 400 && status < 500) {
    return { retryable: false, reason: 'client_error', detail: `permanent ${status}` };
  }
  if (TRANSPORT_ERRORS.test(`${code ?? ''} ${message ?? ''}`)) {
    return { retryable: true, reason: 'transport' };
  }
  if (status && status >= 500) return { retryable: true, reason: 'transient_server' };
  return { retryable: false, reason: 'unknown', detail: message ?? null };
}

// A 429 that tells us when to come back beats our own guess.
export function retryAfterMs(headers = {}) {
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}
