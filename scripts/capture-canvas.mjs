// Screenshots n8n canvases. The editor is behind a login and the canvas is a Vue app,
// so this needs a real browser rather than a URL fetch.
//
//   docker run --rm --network=leadops_default -u 0 \
//     -v "$PWD/scripts":/s -v "$PWD/05_Test_Evidence":/out \
//     -e N8N_OWNER_EMAIL -e N8N_OWNER_PASSWORD \
//     --entrypoint node zenika/alpine-chrome:with-puppeteer /s/capture-canvas.mjs

import puppeteer from 'puppeteer-core';

const N8N = process.env.N8N_URL ?? 'http://n8n:5678';
const EMAIL = process.env.N8N_OWNER_EMAIL;
const PASSWORD = process.env.N8N_OWNER_PASSWORD;
const OUT = process.env.OUT_DIR ?? '/out';

const TARGETS = [
  ['wf10pipelinecore', 'canvas-pipeline-core.png'],
  ['wf20outbounddisp', 'canvas-outbound-dispatch.png'],
];

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium-browser',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 1680, height: 1000 },
});

try {
  const page = await browser.newPage();

  // Log in through the API and inject the cookie rather than driving the sign-in
  // form. Scraping a login UI breaks whenever the markup changes; the auth endpoint
  // is a contract.
  const res = await fetch(`${N8N}/rest/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emailOrLdapLoginId: EMAIL, password: PASSWORD }),
  });
  const raw = (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')]).filter(Boolean);
  const auth = raw.map((c) => c.split(';')[0]).find((c) => c.startsWith('n8n-auth='));
  if (!auth) throw new Error(`no auth cookie returned (http ${res.status})`);

  const host = new URL(N8N).hostname;
  await page.setCookie({ name: 'n8n-auth', value: auth.split('=').slice(1).join('='), domain: host, path: '/' });
  console.log('signed in as', EMAIL);

  for (const [id, file] of TARGETS) {
    await page.goto(`${N8N}/workflow/${id}`, { waitUntil: 'networkidle2', timeout: 60000 });
    // The canvas renders asynchronously and then fits itself to the viewport.
    await page.waitForSelector('[data-test-id="canvas-wrapper"], .vue-flow', { timeout: 30000 })
      .catch(() => console.log('  canvas selector not found, screenshotting anyway'));
    await new Promise((r) => setTimeout(r, 4500));

    // Zoom-to-fit so the whole graph and its sticky notes are in frame.
    await page.keyboard.down('Control');
    await page.keyboard.press('1');
    await page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 1800));

    await page.screenshot({ path: `${OUT}/${file}` });
    console.log('  wrote', file);
  }
} finally {
  await browser.close();
}
