import { Router } from 'express';

// Keyword-driven rather than stochastic, on purpose: an AI mock that returns
// different answers to the same input makes every downstream test flaky, and the
// edge cases we care about (4: malformed, 5: confident disagreement) are produced
// by fault directives instead.

const SIGNALS = [
  { name: 'urgency',   weight: 2, terms: ['urgent', 'asap', 'immediately', 'this week', 'deadline', 'q1', 'time-sensitive'] },
  { name: 'budget',    weight: 3, terms: ['budget approved', 'budget is', 'funded', 'signed off', 'allocated'] },
  { name: 'authority', weight: 2, terms: ['ceo', 'cto', 'coo', 'head of', 'director', 'vp ', 'decision maker', 'board'] },
  { name: 'scale',     weight: 3, terms: ['enterprise', 'company-wide', 'company wide', 'rollout', 'multi-site', 'transformation', 'group-wide'] },
  { name: 'tyre_kick', weight: -3, terms: ['just looking', 'just curious', 'browsing', 'research', 'no budget', 'next year', 'someday', 'student', 'free', 'thesis'] },
  { name: 'spam',      weight: -8, terms: ['seo services', 'backlink', 'crypto', 'investment opportunity', 'click here', 'guest post', 'ranking'] },
];

function classify(text = '') {
  const haystack = String(text).toLowerCase();
  const hits = [];
  let score = 0;

  for (const sig of SIGNALS) {
    const matched = sig.terms.filter((t) => haystack.includes(t));
    if (matched.length) {
      score += sig.weight * matched.length;
      hits.push({ signal: sig.name, matched, contribution: sig.weight * matched.length });
    }
  }

  let label;
  if (score <= -6) label = 'spam';
  else if (score <= -1) label = 'low_intent';
  else if (score >= 6) label = 'high_potential';
  else if (score >= 2) label = 'moderate';
  else label = 'low_intent';

  // Confidence tracks how much evidence we found, not how extreme the score is.
  // No signals at all should read as an uncertain guess, and it does.
  const evidence = hits.reduce((n, h) => n + h.matched.length, 0);
  const confidence = Number(Math.min(0.95, 0.35 + evidence * 0.12).toFixed(2));

  return { label, confidence, score, hits };
}

export const router = Router();

router.post('/classify', (req, res) => {
  const { free_text_need = '', service_interest = '', lead_id = null } = req.body ?? {};
  const { label, confidence, score, hits } = classify(`${free_text_need} ${service_interest}`);

  res.locals.journal.outcome = 'delivered';
  res.json({
    lead_id,
    label,
    confidence,
    rationale: hits.length
      ? `Matched ${hits.map((h) => h.signal).join(', ')} (net ${score}).`
      : 'No qualifying signals found in the free-text need.',
    model: 'mock-classifier-v1',
    signals: hits,
  });
});
