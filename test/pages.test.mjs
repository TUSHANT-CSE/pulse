import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

let browser, server, base;
const root = new URL('../dist-pages/', import.meta.url);
before(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!/^\/pulse\/(?:[\w./-]*)$/.test(path) || path.includes('..')) { res.writeHead(404); res.end(); return; }
    const file = path.slice('/pulse/'.length) + (path.endsWith('/') ? 'index.html' : '');
    try {
      const body = await readFile(new URL(file, root));
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html';
      res.writeHead(200, { 'Content-Type': type }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/pulse/`;
  browser = await chromium.launch(process.env.PULSE_BROWSER === 'chromium' ? {} : { channel: 'msedge' });
});
after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
async function fixture(t, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => requests.push(request.url()));
  await page.goto(base);
  await page.locator('#summary-metrics[aria-busy="false"]').waitFor();
  return { page, errors, requests };
}
const text = (page, selector, value) => page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.textContent.includes(value), { selector, value });
const dashboard = page => page.evaluate(async () => (await import('./js/pages-demo.js')).demoApi('/api/dashboard'));

test('Pages uses only synthetic assets, preserves project paths and disables Live', async t => {
  const { page, errors, requests } = await fixture(t);
  assert.equal(await page.locator('.monitor-row').count(), 5);
  assert.equal(await page.locator('.mode-control [data-mode="live"]').isDisabled(), true);
  assert.match(await page.locator('#dashboard-shell [data-demo-banner]').textContent(), /All checks, latencies and incidents are synthetic/);
  assert.match(await page.locator('#dashboard-shell [data-connection-text]').textContent(), /Browser demo/);
  assert.match(await page.locator('#monitor-detail').textContent(), /Manual samples only/);
  assert.equal(await page.locator('#dashboard-shell .footer-brand').getAttribute('href'), 'https://github.com/TUSHANT-CSE/pulse');
  await page.screenshot({ path: fileURLToPath(new URL('../docs/images/hosted-demo.png', import.meta.url)), fullPage: false });
  await page.locator('.status-page-link').click();
  await page.locator('.component-card').first().waitFor();
  assert.equal(page.url(), base + 'status/');
  assert.equal(await page.locator('.component-card').count(), 5);
  await page.locator('#public-shell .public-topbar a[href="../"]').click();
  await page.locator('.monitor-row').first().waitFor();
  assert.equal(page.url(), base);
  assert.ok(requests.every(url => url.startsWith(base) && !url.includes('/api/')), requests.join('\n'));
  assert.deepEqual(errors, []);
});

test('Pages scenarios persist through navigation and reset without any API calls', async t => {
  const { page, errors, requests } = await fixture(t);
  await page.locator('[data-scenario="outage"]').click();
  await text(page, '#toast', 'outage simulated');
  assert.equal((await dashboard(page)).monitors[0].status, 'down');
  await page.reload();
  await page.locator('.monitor-row').first().waitFor();
  assert.equal((await dashboard(page)).monitors[0].status, 'down');
  await page.locator('.status-page-link').click();
  await page.locator('.component-card').first().waitFor();
  assert.match(await page.locator('.component-card').first().textContent(), /Down/);
  await page.goto(base);
  await page.locator('.monitor-row').first().waitFor();
  await page.locator('[data-scenario="recovery"]').click();
  await text(page, '#toast', 'Demo recovered');
  assert.equal((await dashboard(page)).monitors[0].status, 'up');
  await page.locator('[data-scenario="latency"]').click();
  await text(page, '#toast', 'Slow demo');
  assert.equal((await dashboard(page)).monitors[0].status, 'degraded');
  await page.locator('[data-reset-demo]').click();
  await text(page, '#toast', 'Synthetic demo reset');
  assert.equal((await dashboard(page)).monitors[0].status, 'up');
  assert.equal((await dashboard(page)).monitors[0].history.length, 144);
  assert.ok(requests.every(url => url.startsWith(base) && !url.includes('/api/')));
  assert.deepEqual(errors, []);
});

test('Pages synthetic create/check/pause/resume/delete and empty state work without network monitoring', async t => {
  const { page, errors, requests } = await fixture(t);
  await page.locator('[data-open-create]').first().click();
  await page.locator('#monitor-name').fill('Portfolio signal');
  assert.equal(await page.locator('#monitor-url').inputValue(), 'https://custom.demo.pulse.example/health');
  await page.locator('#create-submit').click();
  await text(page, '#toast', 'synthetic signal created');
  let d = await dashboard(page);
  const monitor = d.monitors.find(m => m.name === 'Portfolio signal');
  assert.equal(monitor.kind, 'demo'); assert.equal(monitor.status, 'pending');
  await page.locator('[data-monitor-action="check"]').click();
  await text(page, '#toast', 'check succeeded');
  assert.equal((await dashboard(page)).monitors.find(m => m.id === monitor.id).history.length, 1);
  await page.locator('[data-monitor-action="toggle"]').click();
  await text(page, '#toast', 'paused');
  assert.equal(await page.locator('[data-monitor-action="check"]').isDisabled(), true);
  await page.locator('[data-monitor-action="toggle"]').click();
  await text(page, '#toast', 'resumed');
  await page.locator('[data-monitor-action="delete"]').click();
  await page.locator('#delete-submit').click();
  await text(page, '#toast', 'deleted');
  assert.equal((await dashboard(page)).monitors.length, 5);
  // Empty-state and reset are deliberately exercised in the browser's simulator, not the local API.
  await page.evaluate(async () => {
    const { demoApi } = await import('./js/pages-demo.js');
    const d = await demoApi('/api/dashboard');
    for (const m of d.monitors) await demoApi(`/api/monitors/${m.id}`, { method: 'DELETE' });
  });
  await page.locator('#dashboard-shell .topbar [data-retry]').click();
  await text(page, '#monitor-list', 'first signal');
  await page.locator('[data-reset-demo]').click();
  await text(page, '#toast', 'Synthetic demo reset');
  assert.equal(await page.locator('.monitor-row').count(), 5);
  assert.ok(requests.every(url => url.startsWith(base) && !url.includes('/api/')));
  assert.deepEqual(errors, []);
});

test('Pages mobile layouts fit and work without session storage or WebGL', async t => {
  const { page, errors } = await fixture(t, { width: 390, height: 844 });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Dashboard overflow at ${width}`);
  }
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('Storage unavailable'); } });
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) { return /webgl/i.test(type) ? null : get.call(this, type, ...args); };
  });
  await page.reload();
  await page.locator('.monitor-row').first().waitFor();
  assert.equal(await page.locator('#signal-scene').getAttribute('data-renderer'), 'canvas2d');
  await page.locator('[data-reset-demo]').click();
  await text(page, '#toast', 'Synthetic demo reset');
  await page.locator('.status-page-link').click();
  await page.locator('.component-card').first().waitFor();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Status overflow at ${width}`);
  }
  assert.deepEqual(errors, []);
});
