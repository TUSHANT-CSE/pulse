import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { Store } from '../src/store.ts';

// Always use a fresh in-memory store. Never export the user's persistent workspace.
const source = new URL('../public/', import.meta.url);
const target = new URL('../dist-pages/', import.meta.url);
const repository = 'https://github.com/TUSHANT-CSE/pulse';
await rm(target, { recursive: true, force: true });
await mkdir(new URL('status/', target), { recursive: true });
await cp(new URL('css/', source), new URL('css/', target), { recursive: true });
await cp(new URL('js/', source), new URL('js/', target), { recursive: true });
await cp(new URL('./pages-demo.js', import.meta.url), new URL('js/pages-demo.js', target));
const metrics = await readFile(new URL('../src/metrics.ts', import.meta.url), 'utf8');
await writeFile(new URL('js/demo-metrics.js', target), stripTypeScriptTypes(metrics));

const now = Date.now();
const store = new Store();
try {
  store.seedDemo(now);
  const monitors = store.monitors().map(m => ({ ...m, checks: store.checks(m.id) }));
  if (monitors.some(m => m.kind !== 'demo' || !new URL(m.url).hostname.endsWith('.demo.pulse.example'))) throw new Error('Non-synthetic seed rejected.');
  await writeFile(new URL('js/demo-data.json', target), JSON.stringify({ synthetic: true, now, monitors, incidents: store.incidents(now), activity: store.activity() }));
} finally { store.close(); }

let html = await readFile(new URL('index.html', source), 'utf8');
// Fail loudly if a UI change would silently remove the hosted-data disclosure.
function replaceOnce(from, to) {
  if (!html.includes(from)) throw new Error(`Missing Pages template anchor: ${from.slice(0, 70)}`);
  html = html.replace(from, to);
}
replaceOnce('<html lang="en">', '<html lang="en" data-hosting="demo">');
replaceOnce('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">');
replaceOnce('Pulse Signal Studio — local-first uptime monitoring, real HTTP checks and incident history in a living 3D interface.', 'Pulse Signal Studio — an interactive 3D monitoring portfolio demo. All service health and incident data are synthetic. Real HTTP checks require the local app.');
replaceOnce('Real checks, clear timelines, zero guesswork.', 'Synthetic signals. Real interaction. Zero setup.');
replaceOnce('YOUR MACHINE. YOUR DATA. YOUR CONTROL.', 'A PORTFOLIO PLAYGROUND. NOT A LIVE MONITOR.');
replaceOnce('Synthetic services &amp; histories. No real site is affected; HTTP monitors stay paused until you explicitly switch to Live.', 'All checks, latencies and incidents are synthetic. Changes stay in this tab; no monitoring requests are made. Real checks require the local app.');
replaceOnce('<button class="text-button" type="button" data-mode="live">Switch to live<svg class="icon small"><use href="#icon-arrow"/></svg></button>', '<button class="text-button" type="button" data-reset-demo title="Restore the five synthetic services in this tab">Reset demo<svg class="icon small"><use href="#icon-refresh"/></svg></button>');
replaceOnce('data-mode="live" aria-pressed="false">Live', 'data-mode="live" aria-pressed="false" disabled title="Real HTTP monitoring requires the local Node app">Live · local only');
replaceOnce('Monitor a public HTTP or HTTPS endpoint. Local, private, and reserved network addresses are not allowed.', 'Create a synthetic signal in this browser tab. This demo never monitors a real URL. Use Check now to generate samples.');
replaceOnce("This real HTTP monitor will remain paused in Demo. Creating it never changes your mode.", 'No scheduler runs here. Timing fields are demo configuration only; the slow threshold affects synthetic status. The fixed .example address is not contacted.');
replaceOnce('id="create-switch-live">Explicitly switch to Live', 'id="create-switch-live" disabled hidden>Real checks require the local app');
replaceOnce('id="monitor-url" name="url" type="url"', 'id="monitor-url" name="url" value="https://custom.demo.pulse.example/health" readonly type="url"');
replaceOnce('This action cannot be undone.', 'Reset demo restores the original synthetic services; custom signals are not restored.');
html = html.replaceAll('OFFLINE DEMO', 'BROWSER DEMO').replaceAll('Connecting to local server', 'Loading synthetic demo').replaceAll('Local server unavailable', 'Browser demo unavailable').replaceAll('Waiting for local server', 'Loading synthetic samples').replaceAll('Awaiting server data', 'Awaiting demo data').replaceAll('EVENT STREAM', 'DEMO ACTIVITY').replaceAll("Tushant's local workspace", "Tushant's portfolio demo");
html = html.replaceAll('<span class="footer-brand">pulse.</span>', `<a class="footer-brand" href="${repository}" target="_blank" rel="noopener noreferrer" aria-label="View Pulse source on GitHub">pulse. / GitHub</a>`);
for (const [path, prefix] of [['index.html', './'], ['status/index.html', '../']]) {
  const page = html.replaceAll('href="/css/', `href="${prefix}css/`).replaceAll('src="/js/', `src="${prefix}js/`).replaceAll('href="/status"', `href="${prefix}status/"`).replaceAll('href="/"', `href="${prefix}"`);
  await writeFile(new URL(path, target), page);
}
await writeFile(new URL('.nojekyll', target), '');
console.log(`Synthetic portfolio demo built: ${fileURLToPath(target)}`);
