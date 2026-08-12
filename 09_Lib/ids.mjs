import { createHash, randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ULID rather than UUIDv4: lexicographically sortable, so it doubles as a coarse
// arrival order and gives dedup a stable tie-break for which record is the master.
export function ulid(now = Date.now(), rand = randomBytes(10)) {
  let ts = '';
  let t = now;
  for (let i = 9; i >= 0; i--) { ts = CROCKFORD[t % 32] + ts; t = Math.floor(t / 32); }

  let bits = 0, value = 0, out = '';
  for (const byte of rand) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += CROCKFORD[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return (ts + out).slice(0, 26);
}

// Key derivation depends on this being stable for equal content, so key order
// must not leak into the hash.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
