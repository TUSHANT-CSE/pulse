import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Activity, Check, Incident, Mode, Monitor } from './types.ts';

type Row = Record<string, unknown>;
function monitorRow(r: Row): Monitor {
  return { id: String(r.id), name: String(r.name), url: String(r.url), kind: r.kind as Monitor['kind'], enabled: Boolean(r.enabled), intervalSeconds: Number(r.interval_seconds), timeoutMs: Number(r.timeout_ms), slowThresholdMs: Number(r.slow_threshold_ms), createdAt: Number(r.created_at), nextCheckAt: Number(r.next_check_at), consecutiveFailures: Number(r.failures), consecutiveSuccesses: Number(r.successes) };
}
function checkRow(r: Row): Check {
  return { id: String(r.id), monitorId: String(r.monitor_id), at: Number(r.at), ok: Boolean(r.ok), latencyMs: Number(r.latency_ms), statusCode: r.status_code === null ? null : Number(r.status_code), error: r.error === null ? null : String(r.error), attempts: Number(r.attempts) };
}
function incidentRow(r: Row, now: number): Incident {
  const resolvedAt = r.resolved_at === null ? null : Number(r.resolved_at);
  return { id: String(r.id), monitorId: String(r.monitor_id), monitorName: String(r.monitor_name), title: String(r.title), status: resolvedAt === null ? 'investigating' : 'resolved', startedAt: Number(r.started_at), resolvedAt, durationMs: Math.max(0, (resolvedAt ?? now) - Number(r.started_at)), events: JSON.parse(String(r.events)) };
}

export class Store {
  readonly db: DatabaseSync;
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS monitors (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL, interval_seconds INTEGER NOT NULL, timeout_ms INTEGER NOT NULL, slow_threshold_ms INTEGER NOT NULL, created_at INTEGER NOT NULL, next_check_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE, at INTEGER NOT NULL, ok INTEGER NOT NULL, latency_ms REAL NOT NULL, status_code INTEGER, error TEXT, attempts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS checks_monitor_at ON checks(monitor_id,at);
      CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE, title TEXT NOT NULL, started_at INTEGER NOT NULL, resolved_at INTEGER, events TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_incident ON incidents(monitor_id) WHERE resolved_at IS NULL;
      CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, monitor_id TEXT, message TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES ('mode','demo');`);
  }
  close() { this.db.close(); }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  mode(): Mode { return String(this.db.prepare("SELECT value FROM settings WHERE key='mode'").get()?.value) as Mode; }
  setMode(mode: Mode) { this.db.prepare("UPDATE settings SET value=? WHERE key='mode'").run(mode); }
  monitors(): Monitor[] { return this.db.prepare('SELECT * FROM monitors ORDER BY created_at,id').all().map(r => monitorRow(r)); }
  monitor(id: string): Monitor | null { const r = this.db.prepare('SELECT * FROM monitors WHERE id=?').get(id); return r ? monitorRow(r) : null; }
  insertMonitor(m: Monitor) {
    this.db.prepare('INSERT INTO monitors VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(m.id, m.name, m.url, m.kind, Number(m.enabled), m.intervalSeconds, m.timeoutMs, m.slowThresholdMs, m.createdAt, m.nextCheckAt, m.consecutiveFailures, m.consecutiveSuccesses);
  }
  updateMonitor(m: Monitor) {
    this.db.prepare('UPDATE monitors SET name=?,url=?,enabled=?,interval_seconds=?,timeout_ms=?,slow_threshold_ms=?,next_check_at=?,failures=?,successes=? WHERE id=?').run(m.name, m.url, Number(m.enabled), m.intervalSeconds, m.timeoutMs, m.slowThresholdMs, m.nextCheckAt, m.consecutiveFailures, m.consecutiveSuccesses, m.id);
  }
  deleteMonitor(id: string) { this.db.prepare('DELETE FROM monitors WHERE id=?').run(id); }
  checks(id: string, since = 0): Check[] { return this.db.prepare('SELECT * FROM checks WHERE monitor_id=? AND at>=? ORDER BY at,rowid').all(id, since).map(r => checkRow(r)); }
  insertCheck(c: Check) { this.db.prepare('INSERT INTO checks VALUES (?,?,?,?,?,?,?,?)').run(c.id, c.monitorId, c.at, Number(c.ok), c.latencyMs, c.statusCode, c.error, c.attempts); }
  prune(now: number) {
    this.db.prepare('DELETE FROM checks WHERE at<?').run(now - 90_000_000);
    this.db.prepare('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY at DESC,rowid DESC LIMIT 200)').run();
    this.db.prepare('DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at<?').run(now - 30 * 86_400_000);
  }
  incidents(now: number, monitorId?: string): Incident[] {
    const sql = `SELECT i.*,m.name AS monitor_name FROM incidents i JOIN monitors m ON m.id=i.monitor_id
      WHERE ${monitorId ? 'i.monitor_id=? AND ' : ''}(i.resolved_at IS NULL OR i.id IN
        (SELECT id FROM incidents WHERE resolved_at IS NOT NULL ${monitorId ? 'AND monitor_id=?' : ''} ORDER BY started_at DESC LIMIT 100))
      ORDER BY i.started_at DESC`;
    return this.db.prepare(sql).all(...(monitorId ? [monitorId, monitorId] : [])).map(r => incidentRow(r, now));
  }
  openIncident(id: string, now: number): Incident | null { return this.incidents(now, id).find(i => i.status === 'investigating') ?? null; }
  saveIncident(i: Incident) { this.db.prepare('INSERT INTO incidents VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET resolved_at=excluded.resolved_at,events=excluded.events').run(i.id, i.monitorId, i.title, i.startedAt, i.resolvedAt, JSON.stringify(i.events)); }
  addActivity(type: string, message: string, monitorId: string | null, at = Date.now()) { this.db.prepare('INSERT INTO activity VALUES (?,?,?,?,?)').run(randomUUID(), at, type, monitorId, message); }
  activity(): Activity[] { return this.db.prepare('SELECT * FROM activity ORDER BY at DESC,rowid DESC LIMIT 30').all().map(r => ({ id: String(r.id), at: Number(r.at), type: String(r.type), monitorId: r.monitor_id === null ? null : String(r.monitor_id), message: String(r.message) })); }

  seedDemo(now = Date.now()) {
    if (this.db.prepare("SELECT value FROM settings WHERE key='seeded'").get()) return;
    this.transaction(() => {
      const definitions = [
        ['demo_api', 'Edge API', 'api', 220, 700], ['demo_checkout', 'Checkout', 'checkout', 330, 700],
        ['demo_cdn', 'Asset CDN', 'cdn', 78, 500], ['demo_auth', 'Auth Service', 'auth', 145, 600],
        ['demo_worker', 'Event Worker', 'events', 195, 700],
      ] as const;
      for (const [index, [id, name, host, base, threshold]] of definitions.entries()) {
        this.insertMonitor({ id, name, url: `https://${host}.demo.pulse.example/health`, kind: 'demo', enabled: true, intervalSeconds: 20, timeoutMs: 5000, slowThresholdMs: threshold, createdAt: now - 86_400_000 + index, nextCheckAt: now + 20_000, consecutiveFailures: id === 'demo_auth' ? 4 : 0, consecutiveSuccesses: id === 'demo_auth' ? 0 : 5 });
        for (let n = 0; n < 144; n++) {
          const ok = !(id === 'demo_api' && n >= 95 && n <= 99) && !(id === 'demo_auth' && n >= 140);
          const spike = id === 'demo_checkout' && n >= 131 ? 470 : 0;
          const latencyMs = Math.round(base * (1 + Math.sin(n * 0.43 + index) * 0.2 + Math.cos(n * 0.13) * 0.1) + spike);
          this.insertCheck({ id: randomUUID(), monitorId: id, at: now - (143 - n) * 600_000, ok, latencyMs: ok ? latencyMs : 5000, statusCode: ok ? 200 : 503, error: ok ? null : 'Synthetic upstream unavailable.', attempts: ok ? 1 : 2 });
        }
      }
      const start = now - 48 * 600_000;
      const end = now - 42 * 600_000;
      this.saveIncident({ id: randomUUID(), monitorId: 'demo_api', monitorName: 'Edge API', title: 'Edge API availability interruption', status: 'resolved', startedAt: start, resolvedAt: end, durationMs: end - start, events: [
        { at: start, type: 'investigating', message: 'Demo: two consecutive failed runs detected.' },
        { at: end, type: 'resolved', message: 'Demo: two consecutive successful runs confirmed recovery.' },
      ] });
      const authStart = now - 30 * 60_000;
      this.saveIncident({ id: randomUUID(), monitorId: 'demo_auth', monitorName: 'Auth Service', title: 'Auth Service availability interruption', status: 'investigating', startedAt: authStart, resolvedAt: null, durationMs: now - authStart, events: [{ at: authStart, type: 'investigating', message: 'Demo: synthetic HTTP 503 responses are being investigated.' }] });
      this.addActivity('demo_seeded', 'Seeded 24 hours of synthetic checks; no external requests made.', null, now);
      this.addActivity('incident_opened', 'Auth Service: demo incident under investigation.', 'demo_auth', authStart);
      this.addActivity('incident_resolved', 'Edge API: previous demo interruption recovered.', 'demo_api', end);
      this.db.prepare("INSERT INTO settings VALUES ('seeded','yes')").run();
    });
  }
}
