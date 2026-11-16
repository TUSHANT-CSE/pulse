export type Mode = 'demo' | 'live';
export type Health = 'up' | 'degraded' | 'down' | 'paused' | 'pending';
export interface Monitor {
  id: string;
  name: string;
  url: string;
  kind: 'demo' | 'http';
  enabled: boolean;
  intervalSeconds: number;
  timeoutMs: number;
  slowThresholdMs: number;
  createdAt: number;
  nextCheckAt: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}
export interface Check {
  id: string;
  monitorId: string;
  at: number;
  ok: boolean;
  latencyMs: number;
  statusCode: number | null;
  error: string | null;
  attempts: number;
}
export interface CheckResult {
  ok: boolean;
  latencyMs: number;
  statusCode: number | null;
  error: string | null;
  attempts: number;
}
export interface IncidentEvent { at: number; type: string; message: string }
export interface Incident {
  id: string;
  monitorId: string;
  monitorName: string;
  title: string;
  status: 'investigating' | 'resolved';
  startedAt: number;
  resolvedAt: number | null;
  durationMs: number;
  events: IncidentEvent[];
}
export interface Activity { id: string; at: number; type: string; monitorId: string | null; message: string }
export interface MonitorView extends Monitor {
  status: Health;
  uptime24h: number | null;
  latencyMs: number | null;
  p95LatencyMs: number | null;
  lastCheckedAt: number | null;
  history: Check[];
  openIncidentId: string | null;
}
export interface Dashboard {
  mode: Mode;
  now: number;
  summary: { total: number; up: number; down: number; degraded: number; paused: number; uptime24h: number | null; incidentsOpen: number; p95LatencyMs: number | null };
  monitors: MonitorView[];
  incidents: Incident[];
  activity: Activity[];
}
