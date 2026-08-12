// Normalisation is lossy, so nothing here mutates the original value — callers keep
// the raw field alongside the normalised one. Edge case 2 (same number, two formats)
// is solved by comparing normalised values; auditing it needs the raw ones.

// Enough of a dial plan to be correct for the regions this demo uses. Production
// swaps this for libphonenumber-js, which knows about number types, carrier
// prefixes and the many places where national significant number length varies.
const DIAL_PLAN = {
  AE: { cc: '971', nsn: [9] },
  GB: { cc: '44',  nsn: [10] },
  US: { cc: '1',   nsn: [10] },
  DE: { cc: '49',  nsn: [10, 11] },
  JP: { cc: '81',  nsn: [9, 10] },
  EG: { cc: '20',  nsn: [10] },
};

const CC_LOOKUP = Object.entries(DIAL_PLAN)
  .map(([region, { cc }]) => ({ region, cc }))
  .sort((a, b) => b.cc.length - a.cc.length);

export function normalizePhone(raw, defaultRegion = 'AE') {
  const result = { raw: raw ?? null, e164: null, valid: false, reason: null, region: null };
  if (!raw) { result.reason = 'missing'; return result; }

  let s = String(raw).trim();
  const hadPlus = s.startsWith('+') || s.startsWith('00');
  let digits = s.replace(/[^\d]/g, '');

  if (s.startsWith('00')) digits = digits.slice(2);

  if (!digits) { result.reason = 'no_digits'; return result; }

  if (hadPlus) {
    const match = CC_LOOKUP.find(({ cc }) => digits.startsWith(cc));
    if (!match) { result.reason = 'unknown_country_code'; return result; }
    result.region = match.region;
  } else {
    const plan = DIAL_PLAN[defaultRegion];
    if (!plan) { result.reason = 'unknown_default_region'; return result; }
    // Trunk prefix: a leading 0 on a national number is a dialling convention,
    // not part of the number.
    if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
    // Some sources submit the country code without a plus. Treat it as already
    // international when the remainder is a plausible national number.
    if (!digits.startsWith(plan.cc) || !plan.nsn.includes(digits.length - plan.cc.length)) {
      digits = plan.cc + digits;
    }
    result.region = defaultRegion;
  }

  const plan = DIAL_PLAN[result.region];
  const nsnLength = digits.length - plan.cc.length;
  if (!plan.nsn.includes(nsnLength)) {
    result.reason = `bad_length_for_${result.region}`;
    result.e164 = `+${digits}`;
    return result;
  }

  result.e164 = `+${digits}`;
  result.valid = true;
  return result;
}

// Casing and surrounding whitespace are never meaningful in an address.
export function normalizeEmail(raw) {
  const result = { raw: raw ?? null, normalized: null, valid: false, localPart: null, domain: null };
  if (!raw) return result;

  const s = String(raw).trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return result;

  const [local, domain] = [s.slice(0, at), s.slice(at + 1)];
  if (!/^[^\s@]+$/.test(local)) return result;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return result;

  result.normalized = `${local}@${domain}`;
  result.localPart = local;
  result.domain = domain;
  result.valid = true;
  return result;
}

// Gmail-style dot and +tag stripping is a *dedup feature only*. It must never
// replace the address we actually send to — some providers treat those as distinct.
const DOT_INSENSITIVE = new Set(['gmail.com', 'googlemail.com']);

export function emailDedupKey(email) {
  const { valid, localPart, domain } = normalizeEmail(email);
  if (!valid) return null;
  let local = localPart.split('+')[0];
  if (DOT_INSENSITIVE.has(domain)) local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

const HONORIFICS = /^(mr|mrs|ms|miss|dr|prof|eng|sir|madam)\.?\s+/i;

export function normalizeName(raw) {
  if (!raw) return { raw: raw ?? null, normalized: null, tokens: [] };
  const normalized = String(raw)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip combining accents left by NFKD
    .replace(HONORIFICS, '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return { raw, normalized: normalized || null, tokens: normalized ? normalized.split(' ') : [] };
}

const COMPANY_NOISE = /\b(inc|llc|ltd|limited|gmbh|bv|sa|sas|plc|co|corp|corporation|company|group|holdings?|fz-?llc|llp)\b\.?/g;

export function normalizeCompany(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase()
    .replace(/[^\p{L}\p{N}\s&-]/gu, ' ')
    .replace(COMPANY_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}
