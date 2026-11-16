import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, checkMetrics, downsample } from '../src/metrics.ts';
import type { Check } from '../src/types.ts';
const now = 1_800_000_000_000;
const check = (at: number, ok = true, latencyMs = 100): Check => ({ id: String(at), monitorId: 'm', at, ok, latencyMs, statusCode: ok ? 200 : 503, error: ok ? null : 'failed', attempts: 1 });

test('percentiles use nearest-rank and ignore non-finite values', () => {
  assert.equal(percentile([20, 10, 100, NaN, Infinity], 0.5), 20);
  assert.equal(percentile([20, 10, 100], 0.95), 100);
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([5], 0), 5);
});
test('availability is the exact successful-check fraction in the selected window', () => {
  const result = checkMetrics([check(now - 1000), check(now - 2000, false), check(now - 90_000_000), check(now + 1000)], now);
  assert.equal(result.samples, 2); assert.equal(result.uptime, 50); assert.equal(result.p95, 100);
});
test('failed timeouts do not inflate successful response latency percentiles', () => {
  assert.equal(checkMetrics([check(now, false, 5000), check(now - 1, true, 50)], now).p95, 50);
});
test('no samples reports null rather than invented perfect uptime', () => {
  assert.equal(checkMetrics([], now).uptime, null);
  assert.equal(checkMetrics([], now).p50, null);
});
test('chart downsampling is bounded and preserves the first and final samples', () => {
  const rows = Array.from({ length: 1000 }, (_, at) => ({ at }));
  const selected = downsample(rows, 144);
  assert.equal(selected.length, 144); assert.equal(selected[0].at, 0); assert.equal(selected.at(-1)?.at, 999);
  assert.ok(selected.every((r, i) => i === 0 || r.at > selected[i - 1].at));
});
