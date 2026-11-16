import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.ts';
import { PulseService } from '../src/service.ts';
import { createPulseServer } from '../src/server.ts';

let browser;
before(async () => { browser = await chromium.launch(process.env.PULSE_BROWSER === 'chromium' ? {} : { channel: 'msedge' }); });
after(async () => { await browser?.close(); });
async function fixture(t, mobile = false, { motion = 'reduce', noWebGL = false } = {}) {
  const store = new Store();
  const now = Date.now();
  const service = new PulseService(store, { now: () => now });
  const app = createPulseServer(service);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, reducedMotion: motion });
  if (noWebGL) await context.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return /webgl/i.test(type) ? null : getContext.call(this, type, ...args);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  t.after(async () => { await context.close(); await app.close(); store.close(); });
  await page.goto(base);
  await page.locator('#summary-metrics[aria-busy="false"]').waitFor();
  return { store, service, app, base, context, page, errors };
}
const visibleText = (page, selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
const image = name => fileURLToPath(new URL(`../docs/images/${name}.png`, import.meta.url));

test('dashboard loads real API data without script/CSP errors and renders accessible charts', async t => {
  const { page, errors } = await fixture(t);
  assert.equal(await page.locator('.monitor-row').count(), 5);
  assert.equal(await page.locator('#latency-chart .chart-sample').count(), 144);
  assert.equal(await page.locator('[data-demo-banner]').first().isVisible(), true);
  await page.locator('.monitor-row[data-select="demo_checkout"]').click();
  await visibleText(page, '#chart-subtitle', 'Checkout');
  await page.locator('[data-range="1"]').click();
  assert.ok(await page.locator('#latency-chart .chart-sample').count() <= 7);
  const sample = page.locator('#latency-chart [tabindex="0"]');
  await sample.focus(); await page.keyboard.press('ArrowLeft');
  assert.match(await page.locator('#chart-tooltip').textContent(), /Successful|Failed/);
  assert.deepEqual(errors, []);
});

test('search, filters, empty results and focus survive an SSE data update', async t => {
  const { page, service } = await fixture(t);
  await page.locator('#monitor-search').fill('Checkout');
  assert.equal(await page.locator('.monitor-row').count(), 1);
  service.update('demo_cdn', { enabled: false });
  await page.waitForFunction(() => document.querySelector('#summary-metrics').textContent.includes('1 paused'));
  assert.equal(await page.locator('#monitor-search').inputValue(), 'Checkout');
  assert.equal(await page.locator('#monitor-search').evaluate(element => element === document.activeElement), true);
  assert.equal(await page.locator('.monitor-row').count(), 1);
  await page.locator('#monitor-search').fill('not-a-monitor');
  assert.equal(await page.locator('[data-clear-search]').isVisible(), true);
  await page.locator('[data-clear-search]').click();
  await page.locator('[data-filter="down"]').click();
  assert.equal(await page.locator('.monitor-row').count(), 1);
  await page.locator('[data-filter="all"]').click();
  assert.equal(await page.locator('.monitor-row').count(), 5);
  const unsafeName = '<img src=x onerror="window.injected=true">';
  service.update('demo_api', { name: unsafeName });
  await visibleText(page, '#monitor-list', unsafeName);
  assert.equal(await page.locator('#monitor-list img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected === true), false);
});

test('scenario buttons open/recover incidents, preserve tied latest results, and mark slow responses', async t => {
  const { page, service, errors } = await fixture(t);
  await page.locator('[data-scenario="outage"]').click();
  await visibleText(page, '#toast', 'outage simulated');
  assert.equal(service.detail('demo_api').monitor.status, 'down');
  await page.locator('[data-scenario="recovery"]').click();
  await visibleText(page, '#toast', 'Demo recovered');
  assert.equal(service.detail('demo_api').monitor.status, 'up');
  await visibleText(page, '#monitor-detail', 'Successful');
  await page.locator('[data-scenario="latency"]').click();
  await visibleText(page, '#toast', 'Slow demo');
  assert.equal(service.detail('demo_api').monitor.status, 'degraded');
  assert.deepEqual(errors, []);
});

test('create validation, explicit Live confirmation, pause/resume and JSON deletion integrate correctly', async t => {
  const { page, service, store } = await fixture(t);
  await page.locator('[data-open-create]').first().click();
  assert.equal(await page.locator('#monitor-name').getAttribute('maxlength'), '80');
  await page.locator('#monitor-name').fill('Browser example');
  await page.locator('#monitor-url').fill('http://127.0.0.1');
  await page.locator('#create-submit').click();
  await visibleText(page, '#create-error', 'reserved');
  // Creation validates real public DNS but Demo must not run any HTTP checks.
  await page.locator('#monitor-url').fill('https://example.com/');
  await page.locator('#create-submit').click();
  await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  const monitor = store.monitors().find(m => m.name === 'Browser example');
  assert.ok(monitor); assert.equal(service.mode(), 'demo');
  assert.equal(store.checks(monitor.id).length, 0);
  await page.locator('.mode-control [data-mode="live"]').click();
  assert.equal(service.mode(), 'demo');
  await page.locator('#mode-confirm').click();
  await visibleText(page, '#toast', 'Switched to Live');
  assert.equal(service.mode(), 'live');
  await page.locator('[data-monitor-action="check"]').click();
  await visibleText(page, '#toast', 'check succeeded');
  assert.equal(store.checks(monitor.id).at(-1).statusCode, 200);
  await page.locator('[data-monitor-action="toggle"]').click();
  await visibleText(page, '#toast', 'paused');
  assert.equal(store.monitor(monitor.id).enabled, false);
  await page.locator('[data-monitor-action="toggle"]').click();
  await visibleText(page, '#toast', 'resumed');
  await page.locator('[data-monitor-action="delete"]').click();
  await page.locator('#delete-submit').click();
  await page.locator('#delete-dialog').waitFor({ state: 'hidden' });
  assert.equal(store.monitor(monitor.id), null);
});

test('native dialogs support keyboard dismissal and focus restoration', async t => {
  const { page } = await fixture(t);
  const opener = page.locator('[data-open-create]').first();
  await opener.focus(); await page.keyboard.press('n');
  assert.equal(await page.locator('#create-dialog').isVisible(), true);
  for (let n = 0; n < 14; n++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.closest('#create-dialog') !== null), true);
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#create-dialog').isVisible(), false);
  assert.equal(await opener.evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('/');
  assert.equal(await page.locator('#monitor-search').evaluate(element => element === document.activeElement), true);
  await opener.click();
  await page.locator('#create-switch-live').click();
  assert.equal(await page.locator('#mode-dialog').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#create-dialog').isVisible(), true);
  assert.equal(await page.locator('#create-switch-live').evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Escape');
});

test('public status is rendered under CSP, uses only read-only public API, and shows unknown without measurements', async t => {
  const { page, base, service, errors } = await fixture(t);
  const requests = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push({ url: request.url(), method: request.method() }); });
  await page.goto(base + '/status');
  await page.locator('.component-card').first().waitFor();
  assert.equal(await page.locator('#dashboard-shell').isVisible(), false);
  assert.equal(await page.locator('.component-card').count(), 5);
  assert.ok(!requests.some(request => request.url.includes('/api/dashboard') || request.method !== 'GET'));
  assert.ok(!JSON.stringify(await service.status()).includes('https://'));
  service.setMode('live');
  await visibleText(page, '#public-overall', 'No active service status');
  assert.deepEqual(errors, []);
});

test('lost API connection keeps stale data honest, disables actions, and recovers after retry', async t => {
  const { page } = await fixture(t);
  await page.route('**/api/dashboard', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Test server unavailable.' }) }));
  await page.locator('[data-retry]').first().click();
  await visibleText(page, '[data-load-error-text]', 'stale');
  assert.equal(await page.locator('[data-monitor-action="check"]').isDisabled(), true);
  assert.equal(await page.locator('.monitor-row').count(), 5);
  await page.unroute('**/api/dashboard');
  await page.locator('[data-retry]').first().click();
  await page.locator('[data-load-error]').first().waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[data-monitor-action="check"]').isDisabled(), false);
});

test('3D signal core animates, user pause persists, and orbit controls select actual monitors', async t => {
  const { page, errors } = await fixture(t, false, { motion: 'no-preference' });
  const scene = page.locator('#signal-scene');
  await page.waitForFunction(() => Number(document.querySelector('#signal-scene').dataset.frame) > 3);
  const renderer = await scene.getAttribute('data-renderer');
  assert.ok(['webgl', 'canvas2d'].includes(renderer));
  assert.equal(await scene.getAttribute('data-motion'), 'running');
  assert.equal(await page.locator('.signal-node').count(), 3);
  const orbitControl = page.locator('.signal-node[data-select="demo_auth"]');
  const target = await orbitControl.boundingBox();
  // Approach the floating control with a real pointer: hovering stops its drift.
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  assert.equal(await orbitControl.evaluate(element => getComputedStyle(element).animationPlayState), 'paused');
  await orbitControl.click();
  await visibleText(page, '#chart-subtitle', 'Auth Service');
  assert.equal(await page.locator('[data-select="demo_auth"].monitor-row').getAttribute('aria-pressed'), 'true');
  assert.equal(await orbitControl.evaluate(element => getComputedStyle(element).animationPlayState), 'paused');
  await page.locator('[data-toggle-motion]').first().click();
  await page.waitForFunction(() => document.querySelector('#signal-scene').dataset.motion === 'paused');
  const frame = Number(await scene.getAttribute('data-frame'));
  // Wait through browser frames, not a wall-clock sleep, to verify the renderer is quiescent.
  await page.evaluate(() => new Promise(resolve => { let frames = 0; const tick = () => ++frames >= 12 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick); }));
  assert.equal(Number(await scene.getAttribute('data-frame')), frame);
  await page.reload(); await page.locator('.monitor-row').first().waitFor();
  assert.equal(await page.locator('[data-toggle-motion]').first().getAttribute('aria-pressed'), 'true');
  await page.locator('[data-toggle-motion]').first().click();
  await page.waitForFunction(() => document.querySelector('#signal-scene').dataset.motion === 'running');
  assert.deepEqual(errors, []);
});

test('system reduced motion freezes artwork and leaves all monitoring controls usable', async t => {
  const { page, errors } = await fixture(t);
  assert.equal(await page.locator('#signal-scene').getAttribute('data-motion'), 'paused');
  assert.equal(await page.locator('[data-toggle-motion]').first().isDisabled(), true);
  assert.equal(await page.locator('.signal-node').first().evaluate(element => getComputedStyle(element).animationName), 'none');
  await page.locator('.signal-node').first().click();
  assert.equal(await page.locator('[data-monitor-action="check"]').isEnabled(), true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.querySelector('#signal-scene').dataset.motion === 'running');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('#signal-scene').dataset.motion === 'paused');
  assert.deepEqual(errors, []);
});

test('WebGL-unavailable fallback is visible and status artwork stays read-only', async t => {
  const { page, base, errors } = await fixture(t, true, { noWebGL: true });
  assert.equal(await page.locator('#signal-scene').getAttribute('data-renderer'), 'canvas2d');
  assert.ok(Number(await page.locator('#signal-scene').getAttribute('data-frame')) > 0);
  const bounds = await page.locator('.signal-canvas').first().boundingBox();
  assert.ok(bounds.width > 200 && bounds.height > 200);
  await page.goto(base + '/status'); await page.locator('.component-card').first().waitFor();
  assert.equal(await page.locator('#public-scene').getAttribute('data-renderer'), 'canvas2d');
  assert.equal(await page.locator('#public-shell [data-monitor-action]').count(), 0);
  assert.deepEqual(errors, []);
});

test('scene pauses offscreen, survives context loss, and releases its renderer on destruction', async t => {
  const { page, errors } = await fixture(t, false, { motion: 'no-preference' });
  const scene = page.locator('#signal-scene');
  await page.waitForFunction(() => Number(document.querySelector('#signal-scene').dataset.frame) > 3);
  const size = await scene.locator('canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  assert.ok(size.width <= 850 && size.height <= 600);
  await page.evaluate(() => document.querySelector('#monitors').scrollIntoView({ behavior: 'instant' }));
  await page.waitForFunction(() => document.querySelector('#signal-scene').dataset.motion === 'paused');
  const offscreenFrame = await scene.getAttribute('data-frame');
  await page.evaluate(() => new Promise(resolve => { let frames = 0; const tick = () => ++frames >= 12 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick); }));
  assert.equal(await scene.getAttribute('data-frame'), offscreenFrame);
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(() => document.querySelector('#signal-scene').dataset.motion === 'running');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await scene.getAttribute('data-motion'), 'paused');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
  await page.waitForFunction(() => document.querySelector('#signal-scene').dataset.motion === 'running');
  if (await scene.getAttribute('data-renderer') === 'webgl') {
    const lost = await scene.locator('canvas').evaluate(canvas => {
      const extension = canvas.getContext('webgl').getExtension('WEBGL_lose_context');
      if (!extension) return false;
      extension.loseContext(); return true;
    });
    assert.equal(lost, true, 'Edge exposes the context-loss test extension');
    await page.waitForFunction(() => {
      const container = document.querySelector('#signal-scene');
      if (container.dataset.renderer !== 'canvas2d') return false;
      const canvas = container.querySelector('canvas');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 32) visible++;
      return visible > 1000; // Renderer selection precedes its first animation frame.
    });
  }
  await page.evaluate(async () => {
    const { mountPulseScene } = await import('/js/scene.js');
    const container = document.querySelector('#signal-scene');
    const api = mountPulseScene(container);
    api.destroy(); api.destroy(); api.update({ health: 'up' }); api.setPaused(false);
  });
  assert.equal(await scene.locator('canvas').count(), 0);
  assert.equal(await scene.getAttribute('data-motion'), 'paused');
  const finalFrame = await scene.getAttribute('data-frame');
  await page.evaluate(() => new Promise(resolve => { let frames = 0; const tick = () => ++frames >= 12 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick); }));
  assert.equal(await scene.getAttribute('data-frame'), finalFrame);
  assert.deepEqual(errors, []);
});

test('responsive layouts fit phone/tablet/desktop widths and capture actual synthetic UI demos', async t => {
  const { page, base, context, errors } = await fixture(t, true);
  for (const width of [320, 375, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#latency-chart svg').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `dashboard overflow at ${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-open-create]').first().click();
  const bounds = await page.locator('#create-dialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.keyboard.press('Escape');
  await page.locator('.monitor-row[data-select="demo_checkout"]').click();
  await page.evaluate(() => scrollTo(0, 0));
  await page.setViewportSize({ width: 390, height: 1460 });
  await page.waitForFunction(() => Number(document.querySelector('#signal-scene').dataset.frame) > 0);
  await page.screenshot({ path: image('mobile-dashboard') });
  await page.locator('.detail-panel').screenshot({ path: image('mobile-monitor') });
  await page.goto(base + '/status');
  await page.locator('.component-card').first().waitFor();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `status overflow at ${width}`);
  }
  assert.deepEqual(errors, []);
  const desktop = await context.newPage();
  await desktop.setViewportSize({ width: 1440, height: 1000 });
  await desktop.goto(base); await desktop.locator('.monitor-row').first().waitFor();
  await desktop.locator('.monitor-row[data-select="demo_checkout"]').click();
  await desktop.evaluate(() => scrollTo(0, 0));
  await desktop.screenshot({ path: image('dashboard'), fullPage: true });
  await desktop.locator('[data-scenario="outage"]').click();
  await visibleText(desktop, '#toast', 'outage simulated');
  await desktop.locator('#incident-list details').first().evaluate(element => { element.open = true; });
  await desktop.locator('#incidents').screenshot({ path: image('incident-timeline') });
  await desktop.goto(base + '/status'); await desktop.locator('.component-card').first().waitFor();
  await desktop.screenshot({ path: image('public-status'), fullPage: true });
});
