import type { Check } from './types.ts';

export function percentile(values: number[], quantile: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const q = Math.min(1, Math.max(0, quantile));
  return Math.round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] * 10) / 10;
}

export function checkMetrics(checks: Check[], now = Date.now(), windowMs = 86_400_000) {
  const rows = checks.filter(c => c.at >= now - windowMs && c.at <= now);
  const successful = rows.filter(c => c.ok);
  return {
    samples: rows.length,
    uptime: rows.length ? Math.round(successful.length / rows.length * 10_000) / 100 : null,
    p50: percentile(successful.map(c => c.latencyMs), 0.5),
    p95: percentile(successful.map(c => c.latencyMs), 0.95),
    p99: percentile(successful.map(c => c.latencyMs), 0.99),
  };
}

export function downsample<T extends { at: number }>(rows: T[], limit = 144): T[] {
  if (limit < 2) return rows.length ? [rows.at(-1)!] : [];
  if (rows.length <= limit) return rows;
  const selected: T[] = [];
  for (let i = 0; i < limit; i++) selected.push(rows[Math.round(i * (rows.length - 1) / (limit - 1))]);
  return selected;
}
