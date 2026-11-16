// Browser-only portfolio simulator. Never imports the HTTP checker or sends monitoring requests.
// Loaded only by the separately generated GitHub Pages build, never the local application.
import { checkMetrics, downsample } from './demo-metrics.js';

const storageKey = 'pulse:pages-demo:v1';
let seedPromise;
let data;
const copy = value => structuredClone(value);
const id = () => crypto.randomUUID();
const failure = message => { throw new Error(message); };

async function seed() {
  if (!seedPromise) seedPromise = fetch(new URL('./demo-data.json', import.meta.url), { credentials: 'omit' })
    .then(response => { if (!response.ok) failure('The synthetic demo data could not be loaded. Reload to retry.'); return response.json(); })
    .then(value => { if (value.synthetic !== true || !Array.isArray(value.monitors)) failure('Invalid synthetic demo data.'); return value; })
    .catch(error => { seedPromise = null; throw error; });
  return seedPromise;
}
function save() {
  try { sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, data })); } catch { /* The demo also works without storage. */ }
}
async function reset() {
  data = copy(await seed());
  const shift = Date.now() - data.now;
  for (const monitor of data.monitors) {
    monitor.createdAt += shift;
    monitor.nextCheckAt = null; // Browser samples run only through the controls, not a scheduler.
    for (const check of monitor.checks) check.at += shift;
  }
  for (const incident of data.incidents) {
    incident.startedAt += shift;
    if (incident.resolvedAt !== null) incident.resolvedAt += shift;
    for (const event of incident.events) event.at += shift;
  }
  for (const event of data.activity) event.at += shift;
  data.now = Date.now();
  save();
}
async function initialize() {
  if (data) return;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (saved?.version === 1 && saved.data?.synthetic === true && Array.isArray(saved.data.monitors)
      && Array.isArray(saved.data.incidents) && Array.isArray(saved.data.activity)
      && Number.isFinite(saved.data.now) && saved.data.now > Date.now() - 86_400_000
      && saved.data.monitors.length <= 50 && saved.data.monitors.every(m => m.kind === 'demo' && Array.isArray(m.checks))) data = saved.data;
  } catch { /* Invalid or inaccessible saved state resets safely. */ }
  if (!data) await reset();
}
function activity(type, monitor, message) {
  data.activity.unshift({ id: id(), at: data.now, type, monitorId: monitor?.id ?? null, message: `Browser demo: ${message}` });
  data.activity = data.activity.slice(0, 100);
}
function openIncident(monitor) { return data.incidents.find(i => i.monitorId === monitor.id && i.status === 'investigating'); }
function view(monitor) {
  const { checks, ...base } = monitor;
  const recent = checks.filter(c => c.at >= data.now - 86_400_000 && c.at <= data.now);
  const latest = recent.at(-1);
  const incident = openIncident(monitor);
  const metrics = checkMetrics(recent, data.now);
  const status = !monitor.enabled ? 'paused' : !latest ? 'pending' : incident ? 'down'
    : !latest.ok || latest.latencyMs >= monitor.slowThresholdMs ? 'degraded' : 'up';
  return { ...base, status, uptime24h: metrics.uptime, latencyMs: latest?.latencyMs ?? null,
    p95LatencyMs: metrics.p95, lastCheckedAt: latest?.at ?? null, history: downsample(recent), openIncidentId: incident?.id ?? null };
}
function dashboard() {
  const monitors = data.monitors.map(view);
  const active = data.monitors.filter(m => m.enabled);
  const metrics = checkMetrics(active.flatMap(m => m.checks), data.now);
  const incidents = data.incidents.map(i => ({ ...i, durationMs: (i.resolvedAt ?? data.now) - i.startedAt }));
  return { mode: 'demo', now: data.now, monitors, incidents, activity: data.activity,
    summary: { total: monitors.length, up: monitors.filter(m => m.status === 'up').length,
      down: monitors.filter(m => m.status === 'down').length, degraded: monitors.filter(m => ['degraded', 'pending'].includes(m.status)).length,
      paused: monitors.filter(m => m.status === 'paused').length, uptime24h: metrics.uptime, p95LatencyMs: metrics.p95,
      incidentsOpen: incidents.filter(i => i.status === 'investigating' && active.some(m => m.id === i.monitorId)).length } };
}
function publicStatus() {
  const d = dashboard();
  return { name: 'Pulse demo network', mode: 'demo', now: d.now, uptime24h: d.summary.uptime24h,
    overall: !d.monitors.some(m => m.enabled && m.lastCheckedAt !== null) ? 'unknown'
      : d.summary.down ? 'outage' : d.summary.degraded ? 'degraded' : 'operational',
    components: d.monitors.map(({ id, name, status, uptime24h, lastCheckedAt, history }) => ({ id, name, status, uptime24h, lastCheckedAt,
      history: history.map(({ at, ok, latencyMs }) => ({ at, ok, latencyMs })) })), incidents: d.incidents };
}
function sample(monitor, scenario = 'recovery') {
  if (!monitor.enabled) failure('Resume this synthetic monitor first.');
  const ok = scenario !== 'outage';
  const latencyMs = !ok ? monitor.timeoutMs : scenario === 'latency' ? Math.max(1200, monitor.slowThresholdMs + 100) : Math.min(180, monitor.slowThresholdMs - 1);
  const check = { id: id(), monitorId: monitor.id, at: data.now, ok, latencyMs, statusCode: ok ? 200 : 503,
    error: ok ? null : 'Simulated HTTP 503 — no network request was made.', attempts: ok ? 1 : 2 };
  monitor.checks = [...monitor.checks.filter(c => c.at >= data.now - 86_400_000), check].slice(-1600);
  monitor.consecutiveFailures = ok ? 0 : monitor.consecutiveFailures + 1;
  monitor.consecutiveSuccesses = ok ? monitor.consecutiveSuccesses + 1 : 0;
  const incident = openIncident(monitor);
  if (!ok && monitor.consecutiveFailures >= 2 && !incident) {
    data.incidents.unshift({ id: id(), monitorId: monitor.id, monitorName: monitor.name, title: `${monitor.name} availability interruption`,
      status: 'investigating', startedAt: data.now, resolvedAt: null, durationMs: 0,
      events: [{ at: data.now, type: 'investigating', message: 'Browser demo: two synthetic failed runs. No HTTP requests were sent.' }] });
    activity('incident_opened', monitor, `${monitor.name}: synthetic incident opened.`);
  }
  if (ok && monitor.consecutiveSuccesses >= 2 && incident) {
    incident.status = 'resolved'; incident.resolvedAt = data.now;
    incident.events.push({ at: data.now, type: 'resolved', message: 'Browser demo: two synthetic successful runs confirmed recovery.' });
    activity('incident_resolved', monitor, `${monitor.name}: synthetic incident resolved.`);
  }
  data.incidents = data.incidents.filter(i => i.status === 'investigating').concat(data.incidents.filter(i => i.status === 'resolved').slice(0, 100));
  return check;
}

export async function demoApi(path, { method = 'GET', body = {} } = {}) {
  await initialize();
  data.now = Date.now();
  let result;
  if (method === 'GET' && path === '/api/dashboard') result = dashboard();
  else if (method === 'GET' && path === '/api/status') result = publicStatus();
  else if (method === 'POST' && path === '/api/demo/reset') { await reset(); result = { ok: true }; }
  else if (method === 'POST' && path === '/api/demo/scenario') {
    if (!['outage', 'recovery', 'latency'].includes(body.scenario)) failure('Choose a supported demo scenario.');
    const monitor = data.monitors[0];
    if (!monitor) failure('Add a demo signal or reset the demo first.');
    monitor.enabled = true;
    sample(monitor, body.scenario);
    if (body.scenario !== 'latency') sample(monitor, body.scenario);
    activity(`scenario_${body.scenario}`, monitor, `${monitor.name}: ${body.scenario} simulated.`);
    result = { ok: true };
  } else if (method === 'POST' && path === '/api/monitors') {
    if (data.monitors.length >= 50) failure('This demo supports up to 50 synthetic monitors.');
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 80) failure('Use a name between 1 and 80 characters.');
    for (const [field, min, max] of [['intervalSeconds', 15, 3600], ['timeoutMs', 1000, 15000], ['slowThresholdMs', 100, 10000]]) {
      if (!Number.isInteger(body[field]) || body[field] < min || body[field] > max) failure('Use the displayed whole-number timing limits.');
    }
    const monitor = { id: id(), name, url: 'https://custom.demo.pulse.example/health', kind: 'demo', enabled: true,
      intervalSeconds: body.intervalSeconds, timeoutMs: body.timeoutMs, slowThresholdMs: body.slowThresholdMs,
      createdAt: data.now, nextCheckAt: null, consecutiveFailures: 0, consecutiveSuccesses: 0, checks: [] };
    data.monitors.push(monitor);
    activity('monitor_created', monitor, `${name}: synthetic signal created; sample with Check now.`);
    result = { monitor: view(monitor) };
  } else {
    const route = path.match(/^\/api\/monitors\/([\w-]+)(\/check)?$/);
    const monitor = route && data.monitors.find(m => m.id === route[1]);
    if (!monitor) failure('This operation is unavailable in the hosted demo. Real checks require the local app.');
    if (route[2] && method === 'POST') {
      const check = sample(monitor);
      activity('check_success', monitor, `${monitor.name}: synthetic successful sample generated.`);
      result = { monitor: view(monitor), check };
    } else if (!route[2] && method === 'PATCH' && typeof body.enabled === 'boolean') {
      monitor.enabled = body.enabled;
      activity(body.enabled ? 'monitor_resumed' : 'monitor_paused', monitor, `${monitor.name}: ${body.enabled ? 'resumed' : 'paused'}.`);
      result = { monitor: view(monitor) };
    } else if (!route[2] && method === 'DELETE') {
      data.monitors = data.monitors.filter(m => m.id !== monitor.id);
      data.incidents = data.incidents.filter(i => i.monitorId !== monitor.id);
      activity('monitor_deleted', monitor, `${monitor.name}: removed from this browser demo.`);
      result = { ok: true };
    } else failure('Unsupported browser-demo operation.');
  }
  if (method !== 'GET') save();
  return copy(result);
}
