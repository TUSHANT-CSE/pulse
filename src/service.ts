import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { ApiError } from './errors.ts';
import { checkMetrics, downsample, percentile } from './metrics.ts';
import { parseMonitorUrl, validateTarget } from './url-safety.ts';
import { performHttpCheck } from './checker.ts';
import type { Resolver } from './url-safety.ts';
import type { Check, CheckResult, Dashboard, Mode, Monitor, MonitorView } from './types.ts';

export type Checker = (monitor: Monitor, signal?: AbortSignal) => Promise<CheckResult>;
function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new ApiError(400, 'VALIDATION_ERROR', `${label} must be an integer from ${min} to ${max}.`);
  return n;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new ApiError(400, 'VALIDATION_ERROR', 'Name must contain 1–80 characters.');
  return value.trim();
}

export class PulseService {
  readonly store: Store;
  private checker: Checker;
  private resolver: Resolver | undefined;
  private running = new Map<string, Promise<{ monitor: MonitorView; check: Check }>>();
  private controllers = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private activeChecks = 0;
  private slotQueue: Array<() => void> = [];
  private now: () => number;
  private acquireSlot(signal: AbortSignal): Promise<void> | undefined {
    if (this.activeChecks < 4) { this.activeChecks++; return; }
    return new Promise((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', cancel);
        this.activeChecks++; resolve();
      };
      const cancel = () => {
        this.slotQueue = this.slotQueue.filter(entry => entry !== start);
        reject(new ApiError(409, 'CHECK_CANCELLED', 'The queued check was cancelled.'));
      };
      this.slotQueue.push(start);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  private releaseSlot() { this.activeChecks--; this.slotQueue.shift()?.(); }
  constructor(store: Store, options: { checker?: Checker; resolver?: Resolver; now?: () => number; seed?: boolean } = {}) {
    this.store = store;
    this.now = options.now ?? Date.now;
    this.resolver = options.resolver;
    this.checker = options.checker ?? ((monitor, signal) => performHttpCheck(monitor, { signal }));
    if (options.seed !== false) this.store.seedDemo(this.now());
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit() { for (const listener of this.listeners) { try { listener(); } catch { /* A disconnected subscriber must not interrupt a check. */ } } }
  mode(): Mode { return this.store.mode(); }
  private requireMonitor(id: string): Monitor { const monitor = this.store.monitor(id); if (!monitor) throw new ApiError(404, 'MONITOR_NOT_FOUND', 'This monitor does not exist.'); return monitor; }
  private canRun(m: Monitor) { return m.enabled && ((m.kind === 'demo' && this.mode() === 'demo') || (m.kind === 'http' && this.mode() === 'live')); }
  view(m: Monitor): MonitorView {
    const now = this.now();
    const checks = this.store.checks(m.id, now - 86_400_000);
    const recent = checks.filter(c => c.at <= now);
    const latest = recent.at(-1);
    const metrics = checkMetrics(checks, now);
    const incident = this.store.openIncident(m.id, now);
    let status: MonitorView['status'];
    if (!this.canRun(m)) status = 'paused';
    else if (!latest) status = 'pending';
    else if (incident) status = 'down';
    else if (!latest.ok || latest.latencyMs >= m.slowThresholdMs) status = 'degraded';
    else status = 'up';
    return { ...m, status, uptime24h: metrics.uptime, latencyMs: latest?.latencyMs ?? null, p95LatencyMs: metrics.p95, lastCheckedAt: latest?.at ?? null, history: downsample(recent), openIncidentId: incident?.id ?? null };
  }
  dashboard(): Dashboard {
    const monitors = this.store.monitors().map(m => this.view(m));
    const active = monitors.filter(m => this.canRun(m));
    const checks = active.flatMap(m => this.store.checks(m.id, this.now() - 86_400_000));
    const metrics = checkMetrics(checks, this.now());
    const incidents = this.store.incidents(this.now());
    const relevant = incidents.filter(i => active.some(m => m.id === i.monitorId));
    return { mode: this.mode(), now: this.now(), summary: {
      total: monitors.length, up: monitors.filter(m => m.status === 'up').length, degraded: monitors.filter(m => m.status === 'degraded' || m.status === 'pending').length,
      down: monitors.filter(m => m.status === 'down').length, paused: monitors.filter(m => m.status === 'paused').length,
      uptime24h: metrics.uptime, incidentsOpen: relevant.filter(i => i.status === 'investigating').length,
      p95LatencyMs: percentile(checks.filter(c => c.ok).map(c => c.latencyMs), 0.95),
    }, monitors, incidents, activity: this.store.activity() };
  }
  status() {
    const d = this.dashboard();
    const components = d.monitors.filter(m => (d.mode === 'demo' ? m.kind === 'demo' : m.kind === 'http'));
    const ids = new Set(components.map(m => m.id));
    return {
      name: d.mode === 'demo' ? 'Pulse demo network' : 'Pulse status', mode: d.mode, now: d.now,
      overall: !components.some(m => this.canRun(m) && m.lastCheckedAt !== null) ? 'unknown' : components.some(m => m.status === 'down') ? 'outage' : components.some(m => ['degraded', 'pending'].includes(m.status)) ? 'degraded' : 'operational',
      uptime24h: d.summary.uptime24h,
      components: components.map(m => ({ id: m.id, name: m.name, status: m.status, uptime24h: m.uptime24h, lastCheckedAt: m.lastCheckedAt, history: m.history.map(c => ({ at: c.at, ok: c.ok, latencyMs: c.latencyMs })) })),
      incidents: d.incidents.filter(i => ids.has(i.monitorId)),
    };
  }
  detail(id: string) {
    const m = this.requireMonitor(id);
    return { monitor: this.view(m), incidents: this.store.incidents(this.now(), id), metrics: checkMetrics(this.store.checks(id), this.now()) };
  }
  async create(input: Record<string, unknown>) {
    if (this.store.monitors().length >= 50) throw new ApiError(400, 'MONITOR_LIMIT', 'This local reference app supports up to 50 monitors.');
    const monitorName = name(input.name);
    const url = parseMonitorUrl(input.url).href;
    const intervalSeconds = integer(input.intervalSeconds, 60, 15, 3600, 'Check interval');
    const timeoutMs = integer(input.timeoutMs, 5000, 1000, 15000, 'Timeout');
    const slowThresholdMs = integer(input.slowThresholdMs, 700, 100, 10000, 'Slow-response threshold');
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([validateTarget(url, this.resolver), new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new ApiError(408, 'DNS_TIMEOUT', 'Hostname validation timed out. Please retry.')), 8000);
      })]);
    } finally { if (deadline) clearTimeout(deadline); }
    if (this.stopped) throw new ApiError(503, 'STOPPED', 'Monitor scheduler is stopping.');
    if (this.store.monitors().length >= 50) throw new ApiError(400, 'MONITOR_LIMIT', 'This local reference app supports up to 50 monitors.');
    const m: Monitor = { id: randomUUID(), name: monitorName, url, kind: 'http', enabled: true, intervalSeconds, timeoutMs, slowThresholdMs, createdAt: this.now(), nextCheckAt: this.now(), consecutiveFailures: 0, consecutiveSuccesses: 0 };
    this.store.transaction(() => { this.store.insertMonitor(m); this.store.addActivity('monitor_created', `${m.name}: HTTP monitor created${this.mode() === 'demo' ? '; paused until live mode is selected' : ''}.`, m.id, this.now()); });
    this.emit();
    return { monitor: this.view(m) };
  }
  update(id: string, input: Record<string, unknown>) {
    const m = this.requireMonitor(id);
    if (!Object.keys(input).length || Object.keys(input).some(k => !['enabled', 'name', 'intervalSeconds', 'slowThresholdMs'].includes(k))) throw new ApiError(400, 'VALIDATION_ERROR', 'Supply supported monitor fields.');
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw new ApiError(400, 'VALIDATION_ERROR', 'Enabled must be true or false.');
      m.enabled = input.enabled;
      if (!m.enabled) this.controllers.get(id)?.abort();
      if (m.enabled) m.nextCheckAt = this.now();
    }
    if (input.name !== undefined) m.name = name(input.name);
    if (input.intervalSeconds !== undefined) m.intervalSeconds = integer(input.intervalSeconds, m.intervalSeconds, 15, 3600, 'Check interval');
    if (input.slowThresholdMs !== undefined) m.slowThresholdMs = integer(input.slowThresholdMs, m.slowThresholdMs, 100, 10000, 'Slow-response threshold');
    this.store.transaction(() => { this.store.updateMonitor(m); this.store.addActivity('monitor_updated', `${m.name}: ${m.enabled ? 'monitor enabled or updated' : 'monitor paused'}.`, id, this.now()); });
    this.emit();
    return { monitor: this.view(m) };
  }
  remove(id: string) {
    const m = this.requireMonitor(id);
    this.controllers.get(id)?.abort();
    this.store.transaction(() => { this.store.deleteMonitor(id); this.store.addActivity('monitor_deleted', `${m.name}: monitor and check history removed.`, null, this.now()); });
    this.emit();
    return { ok: true };
  }
  setMode(input: unknown) {
    if (input !== 'demo' && input !== 'live') throw new ApiError(400, 'VALIDATION_ERROR', 'Mode must be demo or live.');
    for (const controller of this.controllers.values()) controller.abort();
    this.store.transaction(() => {
      this.store.setMode(input);
      for (const m of this.store.monitors()) { m.nextCheckAt = this.now(); this.store.updateMonitor(m); }
      this.store.addActivity('mode_changed', input === 'demo' ? 'Demo mode: synthetic checks only. HTTP monitors are paused.' : 'Live mode: public HTTP monitors enabled. Demo simulation is paused.', null, this.now());
    });
    this.emit();
    return { mode: this.mode() };
  }
  private simulated(m: Monitor): CheckResult {
    const phase = Math.floor(this.now() / 20_000);
    const hash = [...m.id].reduce((n, c) => n + c.charCodeAt(0), 0);
    const base = m.id === 'demo_cdn' ? 78 : m.id === 'demo_checkout' ? 330 : 185;
    const latency = Math.round(base * (1 + Math.sin(phase * 0.31 + hash) * 0.24));
    const failure = (phase + hash) % 37 < 2;
    const spike = (phase + hash) % 19 < 3 ? 540 : 0;
    return { ok: !failure, latencyMs: failure ? 5000 : latency + spike, statusCode: failure ? 503 : 200, error: failure ? 'Synthetic upstream unavailable.' : null, attempts: failure ? 2 : 1 };
  }
  async runCheck(id: string, forced?: CheckResult): Promise<{ monitor: MonitorView; check: Check }> {
    if (this.stopped) throw new ApiError(503, 'STOPPED', 'Monitor scheduler is stopping.');
    const existing = this.running.get(id);
    if (existing) return existing;
    const m = this.requireMonitor(id);
    if (!this.canRun(m)) throw new ApiError(409, 'MONITOR_PAUSED', 'This monitor is paused or incompatible with the selected mode.');
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const promise = (async () => {
      let admitted = false;
      try {
      const waiting = this.acquireSlot(controller.signal);
      if (waiting) await waiting;
      admitted = true;
      if (controller.signal.aborted) throw new ApiError(409, 'CHECK_CANCELLED', 'The check was cancelled.');
      const result = forced ?? (m.kind === 'demo' ? this.simulated(m) : await this.checker(m, controller.signal));
      if (controller.signal.aborted || !this.store.monitor(id) || !this.canRun(this.requireMonitor(id))) throw new ApiError(409, 'CHECK_CANCELLED', 'The check was cancelled; no failure was recorded.');
      const at = this.now();
      const check: Check = { ...result, id: randomUUID(), monitorId: id, at };
      this.store.transaction(() => {
        const current = this.requireMonitor(id);
        current.consecutiveFailures = result.ok ? 0 : current.consecutiveFailures + 1;
        current.consecutiveSuccesses = result.ok ? current.consecutiveSuccesses + 1 : 0;
        current.nextCheckAt = at + current.intervalSeconds * 1000;
        this.store.insertCheck(check);
        this.store.updateMonitor(current);
        const open = this.store.openIncident(id, at);
        if (!result.ok && current.consecutiveFailures >= 2 && !open) {
          this.store.saveIncident({ id: randomUUID(), monitorId: id, monitorName: current.name, title: `${current.name} availability interruption`, status: 'investigating', startedAt: at, resolvedAt: null, durationMs: 0, events: [{ at, type: 'investigating', message: 'Two consecutive failed check runs detected after retries.' }] });
          this.store.addActivity('incident_opened', `${current.name}: incident opened after two failed runs.`, id, at);
        } else if (result.ok && current.consecutiveSuccesses >= 2 && open) {
          open.status = 'resolved'; open.resolvedAt = at; open.durationMs = at - open.startedAt;
          open.events.push({ at, type: 'resolved', message: 'Two consecutive successful runs confirmed recovery.' });
          this.store.saveIncident(open);
          this.store.addActivity('incident_resolved', `${current.name}: service recovered; incident resolved.`, id, at);
        }
        this.store.addActivity(result.ok ? 'check_passed' : 'check_failed', `${current.name}: ${result.ok ? `${result.latencyMs} ms response` : result.error ?? 'check failed'}${m.kind === 'demo' ? ' · simulated' : ''}.`, id, at);
        this.store.prune(at);
      });
      this.emit();
      return { monitor: this.view(this.requireMonitor(id)), check };
      } finally { if (admitted) this.releaseSlot(); }
    })();
    this.running.set(id, promise);
    try { return await promise; }
    finally { this.running.delete(id); this.controllers.delete(id); }
  }
  async scenario(input: unknown) {
    if (this.mode() !== 'demo') throw new ApiError(409, 'DEMO_ONLY', 'Scenario controls are available only in demo mode.');
    if (!['outage', 'recovery', 'latency'].includes(String(input))) throw new ApiError(400, 'VALIDATION_ERROR', 'Choose outage, recovery or latency.');
    const m = this.store.monitors().find(monitor => monitor.kind === 'demo');
    if (!m) throw new ApiError(409, 'NO_DEMO_MONITOR', 'No seeded demo monitors remain.');
    const id = m.id;
    if (!m.enabled) this.update(id, { enabled: true });
    const previous = this.running.get(id);
    if (previous) await previous.catch(() => undefined);
    const result: CheckResult = input === 'outage' ? { ok: false, latencyMs: 5000, statusCode: 503, error: 'Synthetic upstream unavailable.', attempts: 2 } : { ok: true, latencyMs: input === 'latency' ? 1200 : 185, statusCode: 200, error: null, attempts: 1 };
    await this.runCheck(id, result);
    if (input !== 'latency') await this.runCheck(id, result);
    this.store.addActivity('demo_scenario', `Demo ${input} applied to ${m.name}; no real website affected.`, id, this.now());
    this.emit();
    return { ok: true };
  }
  async tick() {
    if (this.stopped) return;
    const capacity = Math.max(0, 4 - this.running.size);
    const due = this.store.monitors().filter(m => this.canRun(m) && m.nextCheckAt <= this.now() && !this.running.has(m.id)).sort((a, b) => a.nextCheckAt - b.nextCheckAt).slice(0, capacity);
    await Promise.all(due.map(m => this.runCheck(m.id).catch(() => undefined)));
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.running.values());
    this.listeners.clear();
  }
}
