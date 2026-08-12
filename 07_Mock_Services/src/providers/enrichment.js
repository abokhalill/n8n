import { Router } from 'express';

// Stands in for a Clearbit/Apollo-style firmographic lookup. Keyed on email domain.
const TABLE = {
  'northwind-industrial.com': { company: 'Northwind Industrial', company_size: 4200, industry: 'manufacturing', country: 'DE', region: 'EMEA', revenue_band: '500m-1b', strategic_account: true },
  'zenith-logistics.com':     { company: 'Zenith Logistics',    company_size: 850,  industry: 'logistics',     country: 'AE', region: 'MEA',  revenue_band: '100m-500m', strategic_account: false },
  'lumen-health.io':          { company: 'Lumen Health',        company_size: 120,  industry: 'healthcare',    country: 'GB', region: 'EMEA', revenue_band: '10m-50m',   strategic_account: false },
  'tanaka-mfg.co.jp':         { company: 'Tanaka Manufacturing', company_size: 2100, industry: 'manufacturing', country: 'JP', region: 'APAC', revenue_band: '100m-500m', strategic_account: true },
  'brightpath.co':            { company: 'Brightpath',          company_size: 9,    industry: 'consulting',    country: 'US', region: 'AMER', revenue_band: '<1m',       strategic_account: false },
};

export const router = Router();

router.get('/', (req, res) => {
  const domain = (req.query.domain || String(req.query.email || '').split('@')[1] || '').toLowerCase();
  const data = TABLE[domain];

  // A miss is a successful lookup that found nothing. Returning 404 here would be
  // indistinguishable from the provider being broken, and the pipeline needs to
  // tell "no data" apart from "no answer".
  res.locals.journal.outcome = 'delivered';
  res.json({
    found: Boolean(data),
    domain: domain || null,
    provider: 'mock-firmographics',
    fetched_at: new Date().toISOString(),
    data: data ?? null,
  });
});
