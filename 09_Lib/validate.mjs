import { normalizeCompany, normalizeEmail, normalizeName, normalizePhone } from './normalize.mjs';

// Validation sorts leads into "usable now" and "needs a human or a follow-up
// question". It never drops one silently, because brief section B is explicit that
// incomplete data goes down a Data Completion path rather than into a void.

const SOURCE_FIELD_MAP = {
  website: {
    full_name: ['name', 'full_name', 'fullName'],
    email_raw: ['email', 'email_address'],
    phone_raw: ['phone', 'mobile', 'phone_number'],
    company: ['company', 'organisation', 'organization'],
    service_interest: ['service', 'service_interest', 'interest'],
    free_text_need: ['message', 'notes', 'need', 'comments'],
    country: ['country'],
    budget_band: ['budget', 'budget_band'],
    timeline: ['timeline', 'timeframe'],
    consent: ['consent', 'marketing_consent', 'opt_in'],
  },
  whatsapp: {
    full_name: ['profile_name', 'contact_name', 'name'],
    phone_raw: ['wa_id', 'from', 'phone'],
    free_text_need: ['text', 'body', 'message'],
    email_raw: ['email'],
    company: ['company'],
    service_interest: ['service_interest', 'service'],
    country: ['country'],
    budget_band: ['budget_band'],
    timeline: ['timeline'],
    consent: ['consent', 'opt_in'],
  },
  csv: {
    full_name: ['name', 'full_name', 'Full Name'],
    email_raw: ['email', 'Email'],
    phone_raw: ['phone', 'Phone', 'mobile'],
    company: ['company', 'Company'],
    service_interest: ['service', 'Service', 'service_interest'],
    free_text_need: ['notes', 'Notes', 'need'],
    country: ['country', 'Country'],
    budget_band: ['budget', 'budget_band'],
    timeline: ['timeline'],
    consent: ['consent', 'Consent'],
  },
};

const firstPresent = (payload, keys) => {
  for (const k of keys) {
    const v = payload?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
};

const CONSENT_TRUE = new Set(['true', 'yes', 'y', '1', 'granted', 'opt_in', 'opted_in', 'on']);
const CONSENT_FALSE = new Set(['false', 'no', 'n', '0', 'denied', 'opt_out', 'opted_out', 'off']);

export function toCanonical({ source, payload, defaultRegion = 'AE', receivedAt = null }) {
  const map = SOURCE_FIELD_MAP[source];
  if (!map) throw new Error(`no field map for source "${source}"`);

  const picked = {};
  for (const [field, keys] of Object.entries(map)) picked[field] = firstPresent(payload, keys);

  const phone = normalizePhone(picked.phone_raw, defaultRegion);
  const email = normalizeEmail(picked.email_raw);
  const name = normalizeName(picked.full_name);

  const rawConsent = String(picked.consent ?? '').toLowerCase();
  let consent_status = 'unknown';
  if (CONSENT_TRUE.has(rawConsent)) consent_status = 'granted';
  else if (CONSENT_FALSE.has(rawConsent)) consent_status = 'denied';

  // WhatsApp inbound is an inbound contact from the customer, which is consent to
  // reply on that channel, but not consent to market. Recorded as such rather
  // than assumed either way.
  if (consent_status === 'unknown' && source === 'whatsapp') consent_status = 'granted';

  return {
    source,
    received_at: receivedAt,
    full_name: picked.full_name,
    name_normalized: name.normalized,
    phone_raw: picked.phone_raw,
    phone_e164: phone.e164,
    phone_valid: phone.valid,
    email_raw: picked.email_raw,
    email_normalized: email.normalized,
    email_valid: email.valid,
    company: picked.company,
    company_normalized: normalizeCompany(picked.company),
    service_interest: picked.service_interest,
    free_text_need: picked.free_text_need,
    country: picked.country,
    budget_band: picked.budget_band,
    timeline: picked.timeline,
    consent_status,
    consent_source: source,
    channels_allowed: consent_status === 'granted'
      ? [phone.valid ? 'whatsapp' : null, email.valid ? 'email' : null].filter(Boolean)
      : [],
    _normalization: { phone_reason: phone.reason, phone_region: phone.region },
  };
}

export function validate(lead) {
  const errors = [];
  const warnings = [];

  if (!lead.full_name) errors.push({ field: 'full_name', code: 'missing' });
  if (!lead.phone_valid && !lead.email_valid) {
    errors.push({ field: 'contact', code: 'no_reachable_channel',
      detail: 'neither a valid phone nor a valid email was supplied' });
  }
  if (lead.phone_raw && !lead.phone_valid) {
    warnings.push({ field: 'phone_raw', code: 'unparseable', detail: lead._normalization?.phone_reason });
  }
  if (lead.email_raw && !lead.email_valid) warnings.push({ field: 'email_raw', code: 'unparseable' });
  if (!lead.service_interest) warnings.push({ field: 'service_interest', code: 'missing' });
  if (lead.consent_status === 'denied') {
    warnings.push({ field: 'consent_status', code: 'denied', detail: 'no outbound channel permitted' });
  }
  if (lead.consent_status === 'unknown') warnings.push({ field: 'consent_status', code: 'unknown' });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    // Only a hard error diverts the lead. Warnings travel with it so a human can
    // see what was thin without the pipeline stalling on it.
    disposition: errors.length ? 'data_completion' : null,
    reason: errors.length ? errors.map((e) => `${e.field}:${e.code}`).join(', ') : null,
  };
}
