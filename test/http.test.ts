import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Store } from '../src/store.ts';
import { PulseService } from '../src/service.ts';
import { createPulseServer } from '../src/server.ts';
async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const store = new Store();
  const service = new PulseService(store, { resolver: async () => [{ address: '93.184.216.34', family: 4 }], checker: async () => ({ ok: true, latencyMs: 42, statusCode: 200, error: null, attempts: 1 }) });
  const app = createPulseServer(service);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); store.close(); });
  async function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return fetch(base + path, { method, headers: { ...(method !== 'GET' && method !== 'HEAD' ? { 'content-type': 'application/json' } : {}), ...headers }, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}) });
  }
  return { base, call, service };
}

test('health, dashboard and public status have the documented shapes', async t => {
  const { call } = await fixture(t);
  assert.equal((await (await call('/health')).json()).service, 'pulse');
  const dashboard = await (await call('/api/dashboard')).json();
  assert.equal(dashboard.monitors.length, 5); assert.equal(dashboard.mode, 'demo');
  const status = await (await call('/api/status')).json();
  assert.equal(status.components.length, 5); assert.ok(!JSON.stringify(status).includes('https://'));
});
test('complete HTTP demo lifecycle opens and resolves an incident with public status updates', async t => {
  const { call } = await fixture(t);
  assert.equal((await call('/api/demo/scenario', 'POST', { scenario: 'outage' })).status, 200);
  const detail = await (await call('/api/monitors/demo_api')).json();
  assert.equal(detail.monitor.status, 'down');
  const open = detail.incidents.find((i: { status: string }) => i.status === 'investigating'); assert.ok(open);
  assert.equal((await call('/api/demo/scenario', 'POST', { scenario: 'recovery' })).status, 200);
  const recovered = await (await call('/api/monitors/demo_api')).json();
  assert.equal(recovered.monitor.status, 'up'); assert.equal(recovered.incidents.find((i: { id: string }) => i.id === open.id).status, 'resolved');
});
test('monitor create, mode switch, check, pause, resume and delete work through HTTP', async t => {
  const { call } = await fixture(t);
  const response = await call('/api/monitors', 'POST', { name: 'Example', url: 'https://example.com/health', intervalSeconds: 15 });
  assert.equal(response.status, 201); const { monitor } = await response.json(); assert.equal(monitor.status, 'paused');
  await call('/api/settings', 'POST', { mode: 'live' });
  const checked = await (await call(`/api/monitors/${monitor.id}/check`, 'POST')).json();
  assert.equal(checked.check.statusCode, 200); assert.equal(checked.monitor.status, 'up');
  await call(`/api/monitors/${monitor.id}`, 'PATCH', { enabled: false });
  assert.equal((await call(`/api/monitors/${monitor.id}/check`, 'POST')).status, 409);
  await call(`/api/monitors/${monitor.id}`, 'PATCH', { enabled: true });
  assert.equal((await call(`/api/monitors/${monitor.id}`, 'DELETE')).status, 200);
  assert.equal((await call(`/api/monitors/${monitor.id}`)).status, 404);
});
test('private URLs and invalid form values have explicit errors', async t => {
  const { call } = await fixture(t);
  const response = await call('/api/monitors', 'POST', { name: 'Private', url: 'http://127.0.0.1' });
  assert.equal(response.status, 400); assert.equal((await response.json()).error, 'PRIVATE_ADDRESS');
  assert.equal((await call('/api/settings', 'POST', { mode: 'wrong' })).status, 400);
  assert.equal((await call('/api/demo/scenario', 'POST', { scenario: 'wrong' })).status, 400);
});
test('cross-origin writes and untrusted Host headers are rejected', async t => {
  const { base, call } = await fixture(t);
  assert.equal((await call('/api/settings', 'POST', { mode: 'live' }, { origin: 'https://evil.example' })).status, 403);
  // Fetch normalizes Host; use the wire-level client to exercise this guard.
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(base + '/health', { headers: { Host: 'evil.example' } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject); req.end();
  });
  assert.equal(status, 421);
});
test('JSON object requirement and payload limits are enforced', async t => {
  const { base, call } = await fixture(t);
  assert.equal((await call('/api/settings', 'POST', ['live'])).status, 400);
  assert.equal((await call('/api/settings', 'POST', { text: 'x'.repeat(17_000) })).status, 413);
  assert.equal((await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'live' })).status, 415);
});
test('SSE connects, emits updates after mutations and supports client cancellation', async t => {
  const { base, call } = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(base + '/api/events', { signal: controller.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value); assert.match(first, /event: update/);
  await call('/api/monitors/demo_api', 'PATCH', { enabled: false });
  const second = new TextDecoder().decode((await reader.read()).value); assert.match(second, /event: update/);
  controller.abort(); await reader.cancel().catch(() => undefined);
});
test('static dashboard and status route serve assets with security headers', async t => {
  const { call } = await fixture(t);
  for (const path of ['/', '/status', '/css/style.css', '/js/app.js']) {
    const response = await call(path); assert.equal(response.status, 200, path); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  const response = await call('/status'); assert.match(await response.text(), /Pulse/);
  const head = await call('/', 'HEAD'); assert.equal(head.status, 200); assert.equal(await head.text(), '');
});
test('non-public project files and traversal are never served', async t => {
  const { call } = await fixture(t);
  for (const path of ['/package.json', '/src/server.ts', '/data/pulse.sqlite', '/.env', '/css/%2e%2e/src/server.ts']) assert.equal((await call(path)).status, 404, path);
});
