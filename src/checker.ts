import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { ApiError } from './errors.ts';
import { validateTarget } from './url-safety.ts';
import type { Address, Resolver } from './url-safety.ts';
import type { CheckResult } from './types.ts';

export interface HeaderResult { statusCode: number; location: string | null; latencyMs: number }
export type Requester = (url: URL, address: Address, timeoutMs: number, signal?: AbortSignal) => Promise<HeaderResult>;

/** The socket lookup is pinned to the already-validated address. No cookies,
 * credentials or response bodies are retained. Latency measures headers. */
export const requestHeaders: Requester = (url, address, timeoutMs, signal) => new Promise((resolve, reject) => {
  const started = performance.now();
  let settled = false;
  const transport = url.protocol === 'https:' ? https : http;
  const req = transport.request(url, {
    method: 'GET', agent: false,
    family: address.family as 4 | 6,
    lookup: (_host, _options, callback) => callback(null, address.address, address.family),
    headers: { 'user-agent': 'Pulse-Local-Monitor/1.0', accept: '*/*', 'cache-control': 'no-cache' },
    signal,
  });
  const timer = setTimeout(() => req.destroy(new Error('TIMEOUT')), timeoutMs);
  req.once('response', res => {
    if (settled) { res.destroy(); return; }
    settled = true;
    clearTimeout(timer);
    resolve({ statusCode: res.statusCode ?? 0, location: res.headers.location ?? null, latencyMs: performance.now() - started });
    res.destroy();
  });
  req.once('error', error => {
    clearTimeout(timer);
    if (!settled) { settled = true; reject(error); }
  });
  req.end();
});

async function attempt(url: string, timeoutMs: number, resolver: Resolver | undefined, requester: Requester, signal?: AbortSignal): Promise<HeaderResult> {
  const started = performance.now();
  let target = url;
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(combinedSignal.reason);
    if (combinedSignal.aborted) onAbort();
    else combinedSignal.addEventListener('abort', onAbort, { once: true });
  });
  const timeout = setTimeout(() => controller.abort(new Error('TIMEOUT')), timeoutMs);
  const remainingTime = () => {
    combinedSignal.throwIfAborted();
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0) throw new Error('TIMEOUT');
    return remaining;
  };
  try {
    const operation = (async () => {
      for (let redirect = 0; redirect <= 3; redirect++) {
        remainingTime();
        const vetted = await validateTarget(target, resolver);
        let headers: HeaderResult | undefined;
        // Only connection/TLS failures try another address from this hop's
        // fully vetted DNS result; HTTP responses and redirects never do.
        for (const [index, address] of vetted.addresses.entries()) {
          const remaining = remainingTime();
          try {
            headers = await requester(vetted.url, address, remaining, combinedSignal);
            break;
          } catch (error) {
            combinedSignal.throwIfAborted();
            if (error instanceof ApiError || (error instanceof Error && (error.message === 'TIMEOUT' || error.name === 'AbortError')) || index === vetted.addresses.length - 1) throw error;
          }
        }
        remainingTime();
        if (!headers) throw new Error('Connection or TLS request failed.');
        if ([301, 302, 303, 307, 308].includes(headers.statusCode) && headers.location) {
          if (redirect === 3) throw new ApiError(400, 'REDIRECT_LIMIT', 'Redirect limit exceeded.');
          target = new URL(headers.location, vetted.url).href;
          continue;
        }
        return { ...headers, latencyMs: Math.round((performance.now() - started) * 10) / 10 };
      }
      throw new Error('REDIRECT_LIMIT');
    })();
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timeout);
    combinedSignal.removeEventListener('abort', onAbort);
  }
}

export async function performHttpCheck(
  monitor: { url: string; timeoutMs: number },
  options: { resolver?: Resolver; requester?: Requester; signal?: AbortSignal; retryDelayMs?: number } = {},
): Promise<CheckResult> {
  const started = performance.now();
  let last: CheckResult = { ok: false, latencyMs: 0, statusCode: null, error: 'Check failed.', attempts: 1 };
  for (let n = 1; n <= 2; n++) {
    if (options.signal?.aborted) return { ...last, error: 'Check cancelled.', attempts: n };
    try {
      const result = await attempt(monitor.url, monitor.timeoutMs, options.resolver, options.requester ?? requestHeaders, options.signal);
      const ok = result.statusCode >= 200 && result.statusCode < 400;
      last = { ok, latencyMs: result.latencyMs, statusCode: result.statusCode, error: ok ? null : `HTTP ${result.statusCode}`, attempts: n };
      if (ok) return last;
    } catch (error) {
      last = { ok: false, latencyMs: Math.round((performance.now() - started) * 10) / 10, statusCode: null,
        error: error instanceof ApiError ? error.message : error instanceof Error && error.message === 'TIMEOUT' ? 'Request timed out.' : 'Connection or TLS request failed.', attempts: n };
      if (options.signal?.aborted) return { ...last, error: 'Check cancelled.' };
      if (error instanceof ApiError && ['PRIVATE_ADDRESS', 'UNSAFE_URL', 'INVALID_URL', 'REDIRECT_LIMIT'].includes(error.code)) return last;
    }
    if (n < 2) {
      try { await wait(options.retryDelayMs ?? 250, undefined, { signal: options.signal }); }
      catch { return { ...last, error: 'Check cancelled.' }; }
    }
  }
  return last;
}
