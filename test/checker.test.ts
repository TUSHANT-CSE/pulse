import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { performHttpCheck, requestHeaders } from '../src/checker.ts';
import type { Requester } from '../src/checker.ts';
const resolver = async () => [{ address: '93.184.216.34', family: 4 }];

test('successful HTTP response needs one attempt and returns a measured latency', async () => {
  const result = await performHttpCheck({ url: 'https://example.com/health', timeoutMs: 1000 }, { resolver, retryDelayMs: 0, requester: async () => ({ statusCode: 200, location: null, latencyMs: 12 }) });
  assert.equal(result.ok, true); assert.equal(result.attempts, 1); assert.equal(result.statusCode, 200);
  assert.ok(result.latencyMs >= 0);
});
test('transient HTTP failure retries and records both attempts', async () => {
  let n = 0;
  const result = await performHttpCheck({ url: 'https://example.com', timeoutMs: 1000 }, { resolver, retryDelayMs: 0, requester: async () => ({ statusCode: ++n === 1 ? 503 : 200, location: null, latencyMs: 5 }) });
  assert.equal(result.ok, true); assert.equal(result.attempts, 2); assert.equal(n, 2);
});
test('persistent failures return a failed result after exactly two attempts', async () => {
  const result = await performHttpCheck({ url: 'https://example.com', timeoutMs: 1000 }, { resolver, retryDelayMs: 0, requester: async () => ({ statusCode: 502, location: null, latencyMs: 5 }) });
  assert.equal(result.ok, false); assert.equal(result.error, 'HTTP 502'); assert.equal(result.attempts, 2);
});
test('unsafe redirects are rejected rather than falling back to another public address', async () => {
  let requests = 0;
  const result = await performHttpCheck({ url: 'https://example.com', timeoutMs: 1000 }, { resolver: async () => [{ address: '2001:200::1', family: 6 }, { address: '93.184.216.34', family: 4 }], retryDelayMs: 0, requester: async () => { requests++; return { statusCode: 302, location: 'http://169.254.169.254/latest', latencyMs: 5 }; } });
  assert.equal(result.ok, false); assert.equal(result.attempts, 1); assert.equal(requests, 1); assert.match(result.error ?? '', /private|reserved/);
});
test('endless redirect chains are bounded', async () => {
  let requests = 0;
  const result = await performHttpCheck({ url: 'https://example.com', timeoutMs: 1000 }, { resolver, retryDelayMs: 0, requester: async () => { requests++; return { statusCode: 302, location: '/again', latencyMs: 1 }; } });
  assert.equal(requests, 4); assert.equal(result.ok, false); assert.match(result.error ?? '', /Redirect limit/);
});
test('DNS rebinding to a private address on a later hop is denied', async () => {
  let dnsCalls = 0, requests = 0;
  const result = await performHttpCheck({ url: 'https://example.com', timeoutMs: 1000 }, { resolver: async () => [{ address: ++dnsCalls === 1 ? '93.184.216.34' : '10.0.0.5', family: 4 }], requester: async () => { requests++; return { statusCode: 302, location: '/next', latencyMs: 1 }; } });
  assert.equal(result.ok, false); assert.equal(requests, 1);
});
test('pinned-address transport exercises a real local HTTP fixture without weakening public URL validation', async t => {
  const fixture = createServer((_req, res) => { res.writeHead(200); res.end('fixture'); });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => fixture.close(() => resolve())));
  const port = (fixture.address() as { port: number }).port;
  // Test-only transport injection sends the vetted public hostname to this
  // local fixture. Production uses requestHeaders with the vetted address.
  const requester: Requester = (url, _address, timeoutMs, signal) => requestHeaders(new URL(`http://example.com:${port}${url.pathname}`), { address: '127.0.0.1', family: 4 }, timeoutMs, signal);
  const result = await performHttpCheck({ url: 'http://example.com/health', timeoutMs: 1000 }, { resolver, requester });
  assert.equal(result.ok, true); assert.equal(result.statusCode, 200);
});
test('timeouts are bounded and cannot launch a late request after DNS resolution', async () => {
  let release!: () => void; let requests = 0;
  const resolverWait = new Promise<void>(resolve => { release = resolve; });
  const result = await performHttpCheck({ url: 'https://example.com', timeoutMs: 15 }, { retryDelayMs: 0, resolver: async () => { await resolverWait; return [{ address: '93.184.216.34', family: 4 }]; }, requester: async () => { requests++; return { statusCode: 200, location: null, latencyMs: 1 }; } });
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.ok, false); assert.equal(result.attempts, 2); assert.equal(requests, 0);
  assert.equal(result.error, 'Request timed out.');
});
test('external cancellation during DNS returns promptly with no retry or late request', { timeout: 1000 }, async t => {
  const controller = new AbortController();
  let release!: () => void; let resolving!: () => void; let requests = 0; let dnsCalls = 0;
  const resolverWait = new Promise<void>(resolve => { release = resolve; });
  const dnsStarted = new Promise<void>(resolve => { resolving = resolve; });
  t.after(release);
  const checking = performHttpCheck({ url: 'https://example.com', timeoutMs: 30_000 }, {
    signal: controller.signal, retryDelayMs: 0,
    resolver: async () => { dnsCalls++; resolving(); await resolverWait; return [{ address: '93.184.216.34', family: 4 }]; },
    requester: async () => { requests++; return { statusCode: 200, location: null, latencyMs: 1 }; },
  });
  await dnsStarted;
  controller.abort();
  const result = await checking;
  assert.equal(result.ok, false); assert.equal(result.error, 'Check cancelled.'); assert.equal(result.attempts, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(dnsCalls, 1); assert.equal(requests, 0);
});
test('dual-stack connection and TLS failures try the alternate vetted address in the same attempt', async () => {
  const ipv6 = { address: '2001:200::1', family: 6 };
  const ipv4 = { address: '93.184.216.34', family: 4 };
  for (const [addresses, code] of [[ [ipv6, ipv4], 'ENETUNREACH' ], [ [ipv4, ipv6], 'ERR_TLS_CERT_ALTNAME_INVALID' ]] as const) {
    let dnsCalls = 0;
    const calls: { address: string; timeoutMs: number; signal: AbortSignal | undefined }[] = [];
    const result = await performHttpCheck({ url: 'https://example.com/health', timeoutMs: 1000 }, {
      retryDelayMs: 0, resolver: async () => { dnsCalls++; return [...addresses]; },
      requester: async (url, address, timeoutMs, signal) => {
        assert.equal(url.hostname, 'example.com'); assert.equal(url.pathname, '/health');
        calls.push({ address: address.address, timeoutMs, signal });
        if (calls.length === 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
          throw Object.assign(new Error('Connection or TLS failure'), { code });
        }
        return { statusCode: 200, location: null, latencyMs: 1 };
      },
    });
    assert.equal(result.ok, true); assert.equal(result.attempts, 1); assert.equal(dnsCalls, 1);
    assert.deepEqual(calls.map(call => call.address), addresses.map(address => address.address));
    assert.ok(calls[0].timeoutMs <= 1000); assert.ok(calls[1].timeoutMs > 0);
    assert.ok(calls[1].timeoutMs < calls[0].timeoutMs);
    assert.strictEqual(calls[0].signal, calls[1].signal);
  }
});
test('each redirect hop resolves once and pins fallback to that hop\'s vetted addresses', async () => {
  const addresses = [
    [{ address: '2001:200::1', family: 6 }, { address: '93.184.216.34', family: 4 }],
    [{ address: '2606:4700:4700::1111', family: 6 }, { address: '1.1.1.1', family: 4 }],
  ];
  const dnsCalls: string[] = []; const requests: string[] = [];
  const result = await performHttpCheck({ url: 'https://example.com', timeoutMs: 1000 }, {
    resolver: async hostname => { dnsCalls.push(hostname); return addresses[dnsCalls.length - 1]; },
    requester: async (url, address) => {
      requests.push(`${url.hostname} ${address.address}`);
      if (address.family === 6) throw new Error('Connection failed');
      return { statusCode: url.hostname === 'example.com' ? 302 : 200, location: url.hostname === 'example.com' ? 'https://example.net/health' : null, latencyMs: 1 };
    },
  });
  assert.equal(result.ok, true); assert.equal(result.attempts, 1);
  assert.deepEqual(dnsCalls, ['example.com', 'example.net']);
  assert.deepEqual(requests, ['example.com 2001:200::1', 'example.com 93.184.216.34', 'example.net 2606:4700:4700::1111', 'example.net 1.1.1.1']);
});
test('HTTP failures retry the check instead of falling back between addresses', async () => {
  const requests: string[] = [];
  const result = await performHttpCheck({ url: 'https://example.com', timeoutMs: 1000 }, {
    retryDelayMs: 0, resolver: async () => [{ address: '2001:200::1', family: 6 }, { address: '93.184.216.34', family: 4 }],
    requester: async (_url, address) => { requests.push(address.address); return { statusCode: requests.length === 1 ? 503 : 200, location: null, latencyMs: 1 }; },
  });
  assert.equal(result.ok, true); assert.equal(result.attempts, 2);
  assert.deepEqual(requests, ['2001:200::1', '2001:200::1']);
});
test('expired attempts cannot launch a late alternate connection', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = []; const signals: (AbortSignal | undefined)[] = [];
  const result = await performHttpCheck({ url: 'https://example.com', timeoutMs: 15 }, {
    retryDelayMs: 0, resolver: async () => [{ address: '2001:200::1', family: 6 }, { address: '93.184.216.34', family: 4 }],
    requester: async (_url, address, _timeoutMs, signal) => { requests.push(address.address); signals.push(signal); await pending; throw new Error('Connection failed'); },
  });
  assert.equal(result.ok, false); assert.equal(result.error, 'Request timed out.'); assert.equal(result.attempts, 2);
  assert.ok(signals.every(signal => signal?.aborted));
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ['2001:200::1', '2001:200::1']);
});
test('production native checks reject private literals and mixed DNS before opening a socket', async () => {
  for (const url of ['http://127.0.0.1/', 'http://[::1]/']) {
    const result = await performHttpCheck({ url, timeoutMs: 1000 });
    assert.equal(result.ok, false); assert.equal(result.attempts, 1); assert.match(result.error ?? '', /private|reserved/);
  }
  const result = await performHttpCheck({ url: 'http://example.com', timeoutMs: 1000 }, {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
  });
  assert.equal(result.ok, false); assert.equal(result.attempts, 1); assert.match(result.error ?? '', /private|reserved/);
});
