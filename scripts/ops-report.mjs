#!/usr/bin/env node
// The operational summary plus the reconstruction query that
// answers "why did this lead get this result".
//
//   node scripts/ops-report.mjs             summary only
//   node scripts/ops-report.mjs <lead_id>   summary plus that lead's full timeline
//   node scripts/ops-report.mjs --md        markdown, for pasting into evidence

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

const psql = (q) => execFileSync('docker',
  ['compose', 'exec', '-T', 'postgres', 'psql', '-U', env.POSTGRES_USER || 'leadops', '-d', 'leadops', '-tAc', q],
  { cwd: ROOT, encoding: 'utf8' }).trim();

const rows = (q) => JSON.parse(psql(`SELECT COALESCE(json_agg(t), '[]') FROM (${q}) t`) || '[]');

const args = process.argv.slice(2);
const asMd = args.includes('--md');
const leadId = args.find((a) => !a.startsWith('--')) ??
  rows(`SELECT lead_id FROM lead ORDER BY ingested_at DESC LIMIT 1`)[0]?.lead_id;

const summary = rows('SELECT * FROM ops_summary')[0] ?? {};

const LABELS = {
  total_leads: 'Leads received', total_source_events: 'Source events accepted',
  qualified: 'Qualified', nurture: 'Nurture', unqualified: 'Unqualified',
  manual_review: 'Manual review', data_completion: 'Awaiting data completion',
  duplicates_merged: 'Duplicates merged', duplicates_in_review: 'Duplicates awaiting review',
  vip_leads: 'VIP flagged', approvals_pending: 'Approvals pending',
  dead_lettered_open: 'Dead-lettered, open', queue_pending: 'Queue pending',
  queue_dead: 'Queue dead', claims_ambiguous: 'Ambiguous effects awaiting reconciliation',
  sla_breached: 'SLA breached',
};

const out = [];
const p = (s = '') => out.push(s);

p(asMd ? '# Operational summary' : '\nOPERATIONAL SUMMARY');
p(asMd ? '' : '='.repeat(56));
if (asMd) { p('| Metric | Count |'); p('|---|---|'); }
for (const [k, label] of Object.entries(LABELS)) {
  const v = summary[k] ?? 0;
  p(asMd ? `| ${label} | ${v} |` : `  ${label.padEnd(42, '.')} ${v}`);
}

if (leadId) {
  const lead = rows(`SELECT lead_id, source, full_name, phone_e164, email_normalized, score, score_band,
                            disposition, owner_id, vip_flag, approval_state, dedup_status, duplicate_of,
                            odoo_lead_id, odoo_stage, status, version
                     FROM lead WHERE lead_id = '${leadId}'`)[0];

  if (lead) {
    p('');
    p(asMd ? `## Lead ${leadId}` : `\nLEAD ${leadId}`);
    p(asMd ? '' : '-'.repeat(56));
    if (asMd) { p('| Field | Value |'); p('|---|---|'); }
    for (const [k, v] of Object.entries(lead)) {
      if (v === null || v === '') continue;
      p(asMd ? `| ${k} | ${v} |` : `  ${k.padEnd(20)} ${v}`);
    }

    const breakdown = rows(`SELECT r->>'rule_id' AS rule, r->>'points' AS points, r->>'reason' AS reason
                            FROM lead, jsonb_array_elements(score_breakdown) r
                            WHERE lead_id = '${leadId}'`);
    if (breakdown.length) {
      p('');
      p(asMd ? '### Score breakdown' : '\n  SCORE BREAKDOWN');
      if (asMd) { p(''); p('| Rule | Points | Reason |'); p('|---|---:|---|'); }
      for (const b of breakdown) {
        p(asMd ? `| ${b.rule} | ${b.points} | ${b.reason} |`
               : `    ${String(b.points).padStart(4)}  ${b.rule.padEnd(20)} ${b.reason}`);
      }
    }

    // The point of the whole audit design: decisions and the external effects they
    // caused, interleaved, in one query.
    const timeline = rows(`SELECT to_char(ts, 'HH24:MI:SS') AS at, entry_kind, label,
                                  COALESCE(detail, '') AS detail, severity
                           FROM lead_timeline WHERE lead_id = '${leadId}' ORDER BY ts, seq NULLS LAST, label`);
    p('');
    p(asMd ? '### Timeline' : '\n  TIMELINE  (decisions interleaved with the effects they caused)');
    if (asMd) { p(''); p('| Time | Kind | Event | Outcome |'); p('|---|---|---|---|'); }
    for (const e of timeline) {
      const mark = e.severity === 'error' ? '!' : e.severity === 'warn' ? '~' : ' ';
      p(asMd ? `| ${e.at} | ${e.entry_kind} | ${e.label} | ${e.detail} |`
             : `   ${mark} ${e.at}  ${e.entry_kind.padEnd(16)} ${e.label.padEnd(28)} ${e.detail}`);
    }
  }
}

p('');
console.log(out.join('\n'));
