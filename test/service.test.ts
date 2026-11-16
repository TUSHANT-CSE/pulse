import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { PulseService } from '../src/service.ts';
import type { CheckResult } from '../src/types.ts';
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const good: CheckResult = { ok: true, latencyMs: 100, statusCode: 200, error: null, attempts: 1 };
const bad: CheckResult = { ok: false, latencyMs: 1000, statusCode: 503, error: 'HTTP 503', attempts: 2 };
function fixture(t: { after: (callback: () => Promise<void>) => void }, seed = true) {
  const store = new Store();
  const service = new PulseService(store, { seed, resolver: publicResolver });
  t.after(async () => { await service.stop(); store.close(); });
  return { store, service };
}

test('demo seeds five monitors and 24-hour synthetic history without an HTTP request', t => {
  const { service } = fixture(t);
  const d = service.dashboard();
  assert.equal(d.mode, 'demo'); assert.equal(d.monitors.length, 5);
  assert.ok(d.monitors.every(m => m.kind === 'demo' && m.history.length === 144));
  assert.ok(d.summary.incidentsOpen >= 1); assert.ok(d.summary.uptime24h !== null);
});
test('demo outage opens one incident; repeated failures never duplicate it', async t => {
  const { service } = fixture(t);
  await service.scenario('outage'); await service.scenario('outage');
  const d = service.detail('demo_api');
  assert.equal(d.monitor.status, 'down'); assert.equal(d.incidents.filter(i => i.status === 'investigating').length, 1);
});
test('recovery requires two consecutive successes before closing an incident', async t => {
  const { service } = fixture(t);
  await service.scenario('outage');
  await service.runCheck('demo_api', good);
  assert.equal(service.detail('demo_api').monitor.status, 'down');
  await service.runCheck('demo_api', good);
  assert.equal(service.detail('demo_api').monitor.status, 'up');
  assert.equal(service.detail('demo_api').incidents.filter(i => i.status === 'investigating').length, 0);
  assert.equal(service.detail('demo_api').incidents[0].events.at(-1)?.type, 'resolved');
});
test('one failed run is degraded, two failed runs trigger an incident', async t => {
  const { service } = fixture(t);
  await service.runCheck('demo_api', bad);
  assert.equal(service.detail('demo_api').monitor.status, 'degraded');
  await service.runCheck('demo_api', bad);
  assert.equal(service.detail('demo_api').monitor.status, 'down');
});
test('slow successful responses are degraded but do not create availability incidents', async t => {
  const { service } = fixture(t);
  await service.scenario('latency');
  assert.equal(service.detail('demo_api').monitor.status, 'degraded');
  assert.equal(service.detail('demo_api').incidents.filter(i => i.status === 'investigating').length, 0);
});
test('pause prevents manual and scheduled checks; resume schedules immediately', async t => {
  const { service, store } = fixture(t);
  service.update('demo_api', { enabled: false });
  const count = store.checks('demo_api').length;
  await assert.rejects(service.runCheck('demo_api'), /paused/);
  await service.tick(); assert.equal(store.checks('demo_api').length, count);
  service.update('demo_api', { enabled: true });
  await service.tick(); assert.equal(store.checks('demo_api').length, count + 1);
});
test('HTTP monitors are paused in demo mode and do not leak URLs through public status', async t => {
  const { service } = fixture(t);
  const { monitor } = await service.create({ name: 'My service', url: 'https://example.com/health?private=value' });
  assert.equal(monitor.status, 'paused');
  await assert.rejects(service.runCheck(monitor.id), /paused/);
  service.setMode('live');
  assert.equal(service.detail(monitor.id).monitor.status, 'pending');
  const publicText = JSON.stringify(service.status());
  assert.ok(!publicText.includes('private=value')); assert.ok(!publicText.includes('example.com'));
  assert.equal(service.status().components.length, 1);
  await assert.rejects(service.scenario('outage'), /demo mode/);
});
test('delete removes monitor, checks and incidents without affecting other monitors', async t => {
  const { service, store } = fixture(t);
  const other = store.checks('demo_checkout').length;
  service.remove('demo_api');
  assert.equal(store.monitor('demo_api'), null); assert.equal(store.checks('demo_api').length, 0);
  assert.equal(store.checks('demo_checkout').length, other);
  assert.throws(() => service.detail('demo_api'), /does not exist/);
});
test('invalid monitor fields and settings are rejected', async t => {
  const { service } = fixture(t);
  await assert.rejects(service.create({ name: '', url: 'https://example.com' }));
  await assert.rejects(service.create({ name: 'X', url: 'https://example.com', intervalSeconds: 1 }));
  assert.throws(() => service.update('demo_api', { enabled: 'false' }));
  assert.throws(() => service.update('demo_api', { mystery: 123 }));
  assert.throws(() => service.setMode('production'));
});
test('persisted settings, monitors and incident history survive a database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-persistence-'));
  const filename = join(directory, 'pulse.sqlite');
  let store = new Store(filename);
  let service = new PulseService(store);
  try {
    await service.scenario('outage'); service.setMode('live'); await service.stop(); store.close();
    store = new Store(filename); service = new PulseService(store);
    assert.equal(service.mode(), 'live'); assert.equal(store.monitors().length, 5);
    assert.equal(store.openIncident('demo_api', Date.now())?.status, 'investigating');
  } finally { await service.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('concurrent requests for one monitor share a single in-flight check', async t => {
  const store = new Store();
  let calls = 0;
  let release!: (result: CheckResult) => void;
  const service = new PulseService(store, { seed: false, resolver: publicResolver, checker: async () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  t.after(async () => { await service.stop(); store.close(); });
  const { monitor } = await service.create({ name: 'Concurrent', url: 'https://example.com' });
  service.setMode('live');
  const first = service.runCheck(monitor.id), second = service.runCheck(monitor.id);
  release(good);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(a.check.id, b.check.id); assert.equal(store.checks(monitor.id).length, 1);
});
test('pausing an in-flight monitor cancels without recording a false failure', async t => {
  const store = new Store();
  let release!: (result: CheckResult) => void;
  const service = new PulseService(store, { seed: false, resolver: publicResolver, checker: async () => new Promise(resolve => { release = resolve; }) });
  t.after(async () => { await service.stop(); store.close(); });
  const { monitor } = await service.create({ name: 'Cancellation', url: 'https://example.com' });
  service.setMode('live'); const pending = service.runCheck(monitor.id);
  service.update(monitor.id, { enabled: false }); release(bad);
  await assert.rejects(pending, /cancelled/); assert.equal(store.checks(monitor.id).length, 0);
});
test('open incidents remain visible beyond the resolved-history limit', t => {
  const { store, service } = fixture(t);
  const now = Date.now();
  for (let n = 0; n < 101; n++) store.saveIncident({ id: `resolved-${n}`, monitorId: 'demo_api', monitorName: 'Edge API', title: 'Resolved', status: 'resolved', startedAt: now + n, resolvedAt: now + n + 1, durationMs: 1, events: [] });
  assert.equal(service.dashboard().summary.incidentsOpen, 1);
  assert.ok(service.status().incidents.some(i => i.monitorId === 'demo_auth' && i.status === 'investigating'));
  assert.equal(store.incidents(now).filter(i => i.status === 'resolved').length, 100);
});
test('manual checks share the scheduler concurrency budget and cancelled queue slots are removed', async t => {
  const store = new Store();
  const releases: Array<(result: CheckResult) => void> = [];
  let active = 0, maximum = 0;
  const service = new PulseService(store, { seed: false, resolver: publicResolver, checker: async () => {
    active++; maximum = Math.max(maximum, active);
    return new Promise<CheckResult>(resolve => releases.push(result => { active--; resolve(result); }));
  } });
  t.after(async () => { await service.stop(); store.close(); });
  const ids: string[] = [];
  for (let n = 0; n < 6; n++) ids.push((await service.create({ name: `Manual ${n}`, url: 'https://example.com' })).monitor.id);
  service.setMode('live');
  const pending = ids.map(id => service.runCheck(id));
  const settled = Promise.allSettled(pending);
  assert.equal(active, 4);
  service.update(ids[5], { enabled: false });
  releases.splice(0).forEach(resolve => resolve(good));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 1);
  releases.splice(0).forEach(resolve => resolve(good));
  const results = await settled;
  assert.equal(maximum, 4);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 5);
  assert.equal(store.checks(ids[5]).length, 0);
});
test('status is unknown without active measurements and demo scenarios survive removal of their first target', async t => {
  const { service } = fixture(t);
  service.setMode('live'); assert.equal(service.status().overall, 'unknown');
  service.setMode('demo'); service.remove('demo_api');
  await service.scenario('outage'); assert.equal(service.detail('demo_checkout').monitor.status, 'down');
});
test('scheduler caps concurrent HTTP checks at four and does not overlap runs', async t => {
  const store = new Store(); const releases: Array<(result: CheckResult) => void> = []; let calls = 0;
  const service = new PulseService(store, { seed: false, resolver: publicResolver, checker: async () => { calls++; return new Promise(resolve => releases.push(resolve)); } });
  t.after(async () => { await service.stop(); store.close(); });
  for (let n = 0; n < 6; n++) await service.create({ name: `Monitor ${n}`, url: 'https://example.com' });
  service.setMode('live'); const pending = service.tick(); await service.tick();
  assert.equal(calls, 4); releases.forEach(resolve => resolve(good)); await pending;
});
