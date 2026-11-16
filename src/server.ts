import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from './store.ts';
import { PulseService } from './service.ts';
import { ApiError } from './errors.ts';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new ApiError(415, 'JSON_REQUIRED', 'Write requests must use application/json.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > 16_384) throw new ApiError(413, 'BODY_TOO_LARGE', 'The request body is too large.');
    chunks.push(part);
  }
  try {
    const object: unknown = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('not an object');
    return object as Record<string, unknown>;
  } catch { throw new ApiError(400, 'INVALID_JSON', 'Provide a valid JSON object.'); }
}

export function createPulseServer(service: PulseService, root = publicRoot) {
  const streams = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const host = req.headers.host ?? '';
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)) throw new ApiError(421, 'INVALID_HOST', 'Pulse is a localhost application.');
      const url = new URL(req.url ?? '/', `http://${host}`);
      const path = decodeURIComponent(url.pathname);
      const method = req.method ?? 'GET';
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This method is not supported.');
      if (!['GET', 'HEAD'].includes(method)) {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) throw new ApiError(403, 'ORIGIN_DENIED', 'Cross-origin write requests are not allowed.');
      }
      if (path === '/health' && method === 'GET') { json(res, 200, { ok: true, service: 'pulse', mode: service.mode() }); return; }
      if (path === '/api/dashboard' && method === 'GET') { json(res, 200, service.dashboard()); return; }
      if (path === '/api/status' && method === 'GET') { json(res, 200, service.status()); return; }
      if (path === '/api/events' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`retry: 2000\nevent: update\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
        streams.add(res);
        const unsubscribe = service.subscribe(() => { if (!res.destroyed && res.writableLength < 65_536) res.write(`event: update\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`); });
        const heartbeat = setInterval(() => { if (!res.destroyed && res.writableLength < 65_536) res.write(': heartbeat\n\n'); }, 15_000);
        heartbeat.unref();
        res.once('close', () => { clearInterval(heartbeat); unsubscribe(); streams.delete(res); });
        return;
      }
      if (path === '/api/monitors' && method === 'POST') { json(res, 201, await service.create(await readJson(req))); return; }
      const monitorRoute = path.match(/^\/api\/monitors\/([\w-]+)(\/check)?$/);
      if (monitorRoute) {
        const id = monitorRoute[1];
        if (monitorRoute[2] && method === 'POST') { await readJson(req); json(res, 200, await service.runCheck(id)); return; }
        if (!monitorRoute[2] && method === 'GET') { json(res, 200, service.detail(id)); return; }
        if (!monitorRoute[2] && method === 'PATCH') { json(res, 200, service.update(id, await readJson(req))); return; }
        if (!monitorRoute[2] && method === 'DELETE') { await readJson(req); json(res, 200, service.remove(id)); return; }
      }
      if (path === '/api/demo/scenario' && method === 'POST') { json(res, 200, await service.scenario((await readJson(req)).scenario)); return; }
      if (path === '/api/settings' && method === 'POST') { json(res, 200, service.setMode((await readJson(req)).mode)); return; }
      if (path.startsWith('/api/')) throw new ApiError(404, 'NOT_FOUND', 'API route not found.');
      if (!['GET', 'HEAD'].includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Static assets are read-only.');
      const relative = ['/', '/index.html', '/status', '/status/'].includes(path) ? 'index.html' : path.slice(1);
      if (!/^(?:index\.html|(?:css|js)\/[\w./-]+)$/.test(relative) || relative.split('/').some(part => part.startsWith('.'))) throw new ApiError(404, 'NOT_FOUND', 'Page not found.');
      const target = resolve(root, relative);
      if (!target.startsWith(resolve(root) + sep)) throw new ApiError(403, 'FORBIDDEN', 'Forbidden.');
      const info = await stat(target);
      if (!info.isFile()) throw new ApiError(404, 'NOT_FOUND', 'Page not found.');
      const body = await readFile(target);
      res.writeHead(200, { 'content-type': mime[extname(target)] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-cache' });
      res.end(method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof ApiError) { json(res, error.status, { error: error.code, message: error.message }); return; }
      if (error instanceof URIError) { json(res, 400, { error: 'INVALID_PATH', message: 'Invalid URL encoding.' }); return; }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { json(res, 404, { error: 'NOT_FOUND', message: 'Page not found.' }); return; }
      console.error('Pulse request failed:', error instanceof Error ? error.message : 'Unknown error');
      json(res, 500, { error: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' });
    }
  });
  server.requestTimeout = 40_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.on('close', () => { for (const stream of streams) stream.end(); });
  return {
    server,
    async close() {
      await service.stop();
      for (const stream of streams) stream.end();
      await new Promise<void>((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); server.closeIdleConnections(); });
    },
  };
}

function openBrowser(url: string) {
  if (process.platform !== 'win32') return;
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' });
  child.on('error', () => console.error(`Open ${url} in your browser.`));
  child.unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  const url = `http://127.0.0.1:${port}/`;
  const store = new Store(resolve(process.env.PULSE_DB ?? 'data/pulse.sqlite'));
  const service = new PulseService(store);
  const app = createPulseServer(service);
  app.server.listen(port, '127.0.0.1', () => {
    service.start();
    console.log(`Pulse running at ${url}\nPublic status: ${url}status\nMode: ${service.mode()} — demo is synthetic; live requires public HTTP monitors.`);
    if (process.argv.includes('--open')) openBrowser(url);
  });
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    try { await app.close(); } finally { store.close(); }
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown(); });
  app.server.on('error', async (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && process.argv.includes('--open')) {
      try {
        const existing = await fetch(`${url}health`, { signal: AbortSignal.timeout(2000) });
        if ((await existing.json()).service === 'pulse') { console.log(`Pulse is already running at ${url}`); openBrowser(url); await service.stop(); store.close(); return; }
      } catch { /* The port belongs to another service. */ }
    }
    console.error(error.message);
    await service.stop();
    store.close();
    process.exitCode = 1;
  });
}
