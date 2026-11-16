import { mountPulseScene } from './scene.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const isPublic = /(?:^|\/)status(?:\/index\.html)?\/?$/.test(location.pathname);
const isHostedDemo = document.documentElement.dataset.hosting === 'demo';
let hostedTransport;
document.documentElement.dataset.view = isPublic ? 'public' : 'dashboard';
const root = $(isPublic ? '#public-shell' : '#dashboard-shell');
const endpoint = isPublic ? '/api/status' : '/api/dashboard';
const state = { data: null, selectedId: null, range: 24, filter: 'all', search: '', online: false, modeBusy: false, scenarioBusy: false, createBusy: false, deletingId: null, pendingMode: null, busy: new Map() };
let source = null;
let streamOpen = false;
let pollTimer = null;
let eventTimer = null;
let toastTimer = null;
let refreshPromise = null;
let refreshQueued = false;
let readController = null;
let lifecycle = 0;
let pageActive = true;
const dialogOpeners = new Map();
const sculpture = mountPulseScene($(isPublic ? '#public-scene' : '#signal-scene'));
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
let motionPaused = false;
try { motionPaused = sessionStorage.getItem('pulse:motion-paused') === 'true'; } catch { /* Storage is optional. */ }
function syncMotion() {
  const paused = motionPaused || motionPreference.matches;
  document.documentElement.dataset.motion = paused ? 'paused' : 'running';
  sculpture.setPaused(paused);
  $$('[data-toggle-motion]', root).forEach(button => {
    button.setAttribute('aria-pressed', String(paused));
    button.setAttribute('aria-label', motionPreference.matches ? 'Visual motion reduced by system preference' : paused ? 'Resume visual motion' : 'Pause visual motion');
    button.disabled = motionPreference.matches;
    $('[data-motion-label]', button).textContent = motionPreference.matches ? 'Reduced motion' : paused ? 'Resume motion' : 'Pause motion';
    $('use', button).setAttribute('href', paused ? '#icon-play' : '#icon-pause');
  });
}
motionPreference.addEventListener('change', syncMotion);
syncMotion();

// Light follows the pointer; data controls and chart coordinates never move.
let lightFrame = null;
let lightTarget = null;
let lightPoint = null;
root.addEventListener('pointermove', event => {
  if (motionPaused || motionPreference.matches || event.pointerType === 'touch') return;
  lightTarget = event.target.closest('.panel, .metric-card');
  if (!lightTarget) return;
  lightPoint = { x: event.clientX, y: event.clientY };
  if (lightFrame) return;
  lightFrame = requestAnimationFrame(() => {
    lightFrame = null;
    if (!lightTarget?.isConnected || document.hidden) return;
    const rect = lightTarget.getBoundingClientRect();
    const x = lightPoint.x - rect.left, y = lightPoint.y - rect.top;
    lightTarget.style.setProperty('--mx', `${x}px`);
    lightTarget.style.setProperty('--my', `${y}px`);
    if (lightTarget.matches('.metric-card')) {
      lightTarget.style.setProperty('--rx', `${(0.5 - y / rect.height) * 3}deg`);
      lightTarget.style.setProperty('--ry', `${(x / rect.width - 0.5) * 3}deg`);
    }
  });
}, { passive: true });
if (typeof IntersectionObserver !== 'undefined') {
  const reveal = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      if (!motionPreference.matches && !motionPaused) entry.target.classList.add('reveal-enter');
      reveal.unobserve(entry.target);
    }
  }, { threshold: 0.08 });
  $$('.overview-grid, .scenario-panel, .monitor-panel, .bottom-grid', root).forEach(element => reveal.observe(element));
}

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const number = (value, decimals = 0) => finite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals }) : '—';
const percentage = (value) => finite(value) ? `${number(value, 2)}%` : '—';
const latency = (value) => finite(value) ? `${number(value)} ms` : '—';
const dateValid = (at) => finite(at) && at > 0 && !Number.isNaN(new Date(at).getTime());
const clock = (at) => dateValid(at) ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const dateTime = (at) => dateValid(at) ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const isoDate = (at) => dateValid(at) ? new Date(at).toISOString() : '';
const timeMarkup = (at, compact = false) => `<time datetime="${escape(isoDate(at))}" title="${escape(dateTime(at))}">${escape(compact ? clock(at) : dateTime(at))}</time>`;
const icon = (name, extra = '') => `<svg class="icon ${escape(extra)}" aria-hidden="true"><use href="#icon-${escape(name)}"/></svg>`;
const statuses = { up: 'Up', degraded: 'Degraded', down: 'Down', paused: 'Paused', pending: 'Pending', investigating: 'Investigating', resolved: 'Resolved' };
const pill = (status) => `<span class="status-pill ${Object.hasOwn(statuses, status) ? status : 'pending'}">${escape(statuses[status] || 'Pending')}</span>`;
const empty = (message, hint = '', symbol = 'pulse') => `<div class="empty-state">${icon(symbol)}<p>${escape(message)}</p>${hint ? `<small>${escape(hint)}</small>` : ''}</div>`;
function duration(ms) {
  if (!finite(ms)) return '—';
  if (ms < 1000) return '< 1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function safeURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function sampleLabel(check) {
  return `${dateTime(check.at)} · ${check.ok ? 'Successful' : 'Failed'} · ${latency(check.latencyMs)}${check.statusCode != null ? ` · HTTP ${check.statusCode}` : ''}${check.attempts != null ? ` · ${check.attempts} attempt${check.attempts === 1 ? '' : 's'}` : ''}${check.error ? ` · ${check.error}` : ''}`;
}
function historyOf(monitor, hours = 24) {
  const now = finite(state.data?.now) ? state.data.now : Date.now();
  return (monitor?.history || []).filter((check) => finite(check.at) && check.at >= now - hours * 3600000 && check.at <= now).sort((a, b) => a.at - b.at);
}
function selectedMonitor() { return state.data?.monitors.find((monitor) => monitor.id === state.selectedId) || null; }
function compatible(monitor) { return monitor && ((monitor.kind === 'http' && state.data?.mode === 'live') || (monitor.kind === 'demo' && state.data?.mode === 'demo')); }
function announce(message) { $('#announcement').textContent = message; }
function toast(message, error = false) {
  clearTimeout(toastTimer);
  const element = $('#toast');
  element.textContent = message;
  element.dataset.error = String(error);
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 9000 : 5000);
}
// Cache the source markup: browsers normalize SVG <use/> and other HTML on serialization.
// Comparing innerHTML would replace unchanged controls and restart their motion on every refresh.
const renderedContent = new WeakMap();
// Replace only data regions. Forms/search remain mounted; focused action controls are restored.
function replaceContent(element, html) {
  if (!element || renderedContent.get(element) === html) return;
  renderedContent.set(element, html);
  const focused = document.activeElement;
  const key = element.contains(focused) ? focused?.dataset.focusKey : null;
  const opened = new Set($$('details[open][data-incident-id]', element).map((item) => item.dataset.incidentId));
  element.innerHTML = html;
  $$('details[data-incident-id]', element).forEach((item) => { if (opened.has(item.dataset.incidentId)) item.open = true; });
  if (key) {
    const next = $$('[data-focus-key]', element).find((item) => item.dataset.focusKey === key);
    if (next && !next.disabled) next.focus({ preventScroll: true });
    else if (!isPublic) $('#monitor-search').focus({ preventScroll: true });
  }
}
async function api(path, { method = 'GET', body, timeout = 12000, signal } = {}) {
  if (isHostedDemo) {
    hostedTransport ??= import('./pages-demo.js');
    return (await hostedTransport).demoApi(path, { method, body });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeout);
  try {
    const response = await fetch(path, { method, headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
    let json;
    try { json = await response.json(); } catch { throw new Error('The local server returned an unreadable response.'); }
    if (!response.ok) {
      const error = new Error(json.message || json.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return json;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(signal?.aborted ? 'Request cancelled.' : 'The local server took too long to respond. Retry to resync; an operation may still finish on the server.');
    if (error instanceof TypeError) throw new Error('Cannot reach the local server. Make sure Pulse is running, then retry.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
function setConnection(kind, message) {
  $$('[data-connection]', root).forEach((element) => { element.dataset.state = kind; });
  $$('[data-connection-text]', root).forEach((element) => { element.textContent = message; });
}
function updateConnection() {
  if (!pageActive || document.hidden) setConnection('sleeping', 'Background updates paused');
  else if (isHostedDemo) setConnection(state.online ? 'connected' : 'offline', state.online ? 'Browser demo · synthetic' : 'Demo unavailable');
  else if (!state.online) setConnection('offline', 'Local server disconnected');
  else if (streamOpen) setConnection('connected', 'Local server connected');
  else setConnection('reconnecting', source ? 'Local server connected · stream reconnecting' : 'Local server connected · polling');
}
function showLoadError(error) {
  if (state.data) renderOrbit();
  $$('[data-load-error]', root).forEach((element) => { element.hidden = false; });
  $$('[data-load-error-text]', root).forEach((element) => { element.textContent = `${error.message}${state.data ? ' Last received data is shown below; it may be stale. Actions are disabled until reconnection.' : ' No monitoring data is available. Nothing here is a claim about public service health.'}`; });
  if (!state.data) {
    if (isPublic) {
      replaceContent($('#public-overall'), `${icon('incident')}<div><div class="eyebrow">STATUS UNKNOWN</div><h2>Unable to fetch service status</h2><p>Local server connectivity is not the same as component health.</p></div>`);
      replaceContent($('#public-components'), empty('No status data available.', 'Use the retry button to reconnect.', 'globe'));
    } else {
      $('#summary-metrics').setAttribute('aria-busy', 'false');
      replaceContent($('#monitor-list'), `<li>${empty('No monitoring data available.', 'Reconnect to the local server to load your monitors.', 'monitor')}</li>`);
      replaceContent($('#latency-chart'), empty('No check history available.', 'Pulse never invents live measurements.'));
    }
  }
}
function refresh() {
  if (!pageActive || document.hidden) return Promise.resolve();
  if (refreshPromise) { refreshQueued = true; return refreshPromise; }
  const generation = lifecycle;
  const controller = new AbortController();
  readController = controller;
  const task = (async () => {
    do {
      refreshQueued = false;
      try {
        const data = await api(endpoint, { signal: controller.signal });
        if (generation !== lifecycle || !pageActive) return;
        if (!data || !['demo', 'live'].includes(data.mode) || !finite(data.now) || (isPublic ? !Array.isArray(data.components) : !Array.isArray(data.monitors) || !data.summary)) throw new Error('The local server returned an unexpected data format.');
        const reconnecting = !state.online && state.data !== null;
        state.data = data;
        state.online = true;
        $$('[data-load-error]', root).forEach((element) => { element.hidden = true; });
        updateConnection();
        if (isPublic) renderPublic(); else renderDashboard();
        if (reconnecting) announce('Local server reconnected. Monitoring data resynchronized.');
      } catch (error) {
        if (generation !== lifecycle || !pageActive) return;
        state.online = false;
        updateConnection();
        showLoadError(error);
        if (!isPublic) updateActionAvailability();
      }
    } while (refreshQueued && generation === lifecycle && pageActive && !document.hidden);
  })();
  refreshPromise = task;
  task.finally(() => {
    if (refreshPromise === task) { refreshPromise = null; readController = null; }
  });
  return task;
}
function scheduleRefresh() {
  clearTimeout(eventTimer);
  eventTimer = setTimeout(() => { eventTimer = null; refresh(); }, 180);
}
function startBackground() {
  if (!pageActive || document.hidden) return;
  if (!isHostedDemo && !source && typeof EventSource !== 'undefined') {
    const current = new EventSource('/api/events');
    source = current;
    current.addEventListener('update', () => { if (source === current) scheduleRefresh(); });
    current.onopen = () => {
      if (source !== current) return;
      streamOpen = true;
      updateConnection();
      scheduleRefresh(); // Reconcile any checks missed during an SSE reconnect.
    };
    current.onerror = () => {
      if (source !== current) return;
      streamOpen = false;
      updateConnection(); // EventSource owns its reconnect; don't create a second stream.
    };
  }
  if (!pollTimer) pollTimer = setInterval(() => { if (!document.hidden && pageActive) refresh(); }, 30000);
}
function stopBackground() {
  if (source) { source.close(); source = null; }
  streamOpen = false;
  clearInterval(pollTimer);
  clearTimeout(eventTimer);
  pollTimer = null;
  eventTimer = null;
}
function renderMode() {
  const mode = state.data.mode;
  $$('[data-demo-banner]', root).forEach((element) => { element.hidden = mode !== 'demo'; });
  if (isPublic) return;
  $$('[data-live-banner]', root).forEach((element) => { element.hidden = mode !== 'live'; });
  $('#scenario-panel').hidden = mode !== 'demo';
  $$('.mode-control [data-mode]', root).forEach((element) => { element.setAttribute('aria-pressed', String(element.dataset.mode === mode)); });
  $('#create-demo-note').hidden = mode !== 'demo';
}
function metric(label, value, unit, footnote, symbol, accented = false) {
  return `<article class="metric-card"><div class="metric-label">${escape(label)}${icon(symbol)}</div><div class="metric-value${accented ? ' accent' : ''}">${escape(value)}${unit ? `<span class="metric-unit">${escape(unit)}</span>` : ''}</div><p>${escape(footnote)}</p></article>`;
}
function renderDashboard() {
  const { summary, monitors, incidents = [], activity = [], now } = state.data;
  if (!monitors.some((monitor) => monitor.id === state.selectedId)) state.selectedId = monitors[0]?.id ?? null;
  renderMode();
  $('#nav-monitor-count').textContent = number(summary.total);
  $('#nav-incident-count').textContent = number(summary.incidentsOpen);
  $('#monitor-list-count').textContent = number(monitors.length);
  $('#incident-count').textContent = number(incidents.length);
  $('#updated-at').textContent = `Synced ${clock(now)}`;
  const healthCaption = !summary.total ? 'No monitors yet — add your first endpoint' : summary.down ? `${summary.down} down · ${summary.up} up · ${summary.degraded} degraded` : summary.degraded ? `${summary.degraded} degraded · ${summary.up} up` : summary.up ? `${summary.up} healthy · ${summary.paused} paused` : `${summary.paused} paused · awaiting active checks`;
  $('#health-caption').textContent = healthCaption;
  $('#health-dot').style.background = summary.down ? 'var(--red)' : summary.degraded ? 'var(--amber)' : summary.up ? 'var(--accent)' : 'var(--muted)';
  replaceContent($('#summary-metrics'), [
    metric('Healthy monitors', number(summary.up), `/ ${number(summary.total)}`, `${number(summary.down)} down · ${number(summary.degraded)} degraded · ${number(summary.paused)} paused`, 'monitor', true),
    metric('Sampled uptime · 24h', finite(summary.uptime24h) ? number(summary.uptime24h, 2) : '—', finite(summary.uptime24h) ? '%' : '', 'Successful sampled checks, not an SLA', 'check'),
    metric('P95 response latency', number(summary.p95LatencyMs), finite(summary.p95LatencyMs) ? 'ms' : '', 'Response-header latency · 24h', 'pulse'),
    metric('Open incidents', number(summary.incidentsOpen), '', summary.incidentsOpen ? 'Investigating — see incident history below' : 'No open incidents reported', 'incident')
  ].join(''));
  $('#summary-metrics').setAttribute('aria-busy', 'false');
  renderMonitorList();
  renderSelection();
  renderIncidents($('#incident-list'), incidents);
  renderActivity($('#activity-list'), activity);
  updateActionAvailability();
}
function sparkline(history) {
  const checks = history.slice(-24);
  if (!checks.length) return `<svg viewBox="0 0 120 28" aria-label="No recent checks" role="img"><path d="M0 14h120" fill="none" stroke="#33485b" stroke-dasharray="3 4"/></svg>`;
  const values = checks.map((check) => finite(check.latencyMs) ? Math.max(0, check.latencyMs) : 0);
  const max = Math.max(1, ...values);
  const points = checks.map((check, index) => ({ x: checks.length === 1 ? 60 : index / (checks.length - 1) * 116 + 2, y: 25 - values[index] / max * 21, check }));
  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 120 28" preserveAspectRatio="none" aria-label="Recent response latency; failed checks are red" role="img"><polyline points="${line}" fill="none" stroke="var(--accent)" stroke-opacity=".65" stroke-width="1.5"/>${points.filter((point) => !point.check.ok).map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2" fill="var(--red)"><title>${escape(sampleLabel(point.check))}</title></circle>`).join('')}</svg><span class="mini-bars" aria-hidden="true">${checks.map((check) => `<span${check.ok ? '' : ' class="failed"'}></span>`).join('')}</span>`;
}
function renderMonitorList() {
  const monitors = state.data?.monitors || [];
  const needle = state.search.trim().toLocaleLowerCase();
  const filtered = monitors.filter((monitor) => (state.filter === 'all' || monitor.status === state.filter) && `${monitor.name} ${monitor.url}`.toLocaleLowerCase().includes(needle));
  $('#monitor-result-count').textContent = `${filtered.length} of ${monitors.length} monitors${state.filter === 'all' ? ' · includes pending' : ''}`;
  let html;
  if (!monitors.length) html = `<li>${empty('Your first signal is one monitor away.', 'Add a public HTTP endpoint to start collecting real checks.', 'monitor')}<div class="empty-state" style="min-height:0;padding-top:0"><button type="button" class="button primary" data-open-create>${icon('plus')}Create your first monitor</button></div></li>`;
  else if (!filtered.length) html = `<li>${empty('No monitors match.', 'Try a different name, URL, or status filter.', 'search')}<div class="empty-state" style="min-height:0;padding-top:0"><button class="button secondary" type="button" data-clear-search>Clear search & filters</button></div></li>`;
  else html = filtered.map((monitor) => `<li><button type="button" class="monitor-row" data-select="${escape(monitor.id)}" data-focus-key="select:${escape(monitor.id)}" aria-pressed="${monitor.id === state.selectedId}" aria-label="Select ${escape(monitor.name)}; ${escape(statuses[monitor.status] || 'Pending')}"><span class="monitor-identity"><span class="monitor-avatar">${icon(monitor.kind === 'demo' ? 'pulse' : 'globe')}</span><span><span class="monitor-name">${escape(monitor.name)}</span><span class="monitor-url">${monitor.kind === 'demo' ? 'DEMO · ' : ''}${escape(monitor.url)}</span></span></span>${pill(monitor.status)}<span class="table-number">${finite(monitor.latencyMs) ? `${escape(number(monitor.latencyMs))}<small> ms</small>` : '—'}</span><span class="table-number">${escape(percentage(monitor.uptime24h))}</span><span class="monitor-sparkline">${sparkline(historyOf(monitor))}</span></button></li>`).join('');
  replaceContent($('#monitor-list'), html);
}
function availabilityHTML(checks) {
  if (!checks.length) return '<div class="no-history" role="img" aria-label="No check samples in this time range"></div>';
  const gap = checks.length > 80 ? 1.5 : 3;
  const width = Math.max(2, (720 - gap * (checks.length - 1)) / checks.length);
  const totalWidth = checks.length * width + (checks.length - 1) * gap;
  const successful = checks.filter((check) => check.ok).length;
  return `<div class="availability-bars"><svg viewBox="0 0 ${totalWidth} 24" preserveAspectRatio="none" role="img" aria-label="${checks.length} sampled checks: ${successful} successful, ${checks.length - successful} failed. Green is successful; red is failed.">${checks.map((check, index) => `<rect x="${(index * (width + gap)).toFixed(2)}" y="0" width="${width.toFixed(2)}" height="24" rx="1.5" fill="${check.ok ? 'var(--accent)' : 'var(--red)'}" opacity="${check.ok ? '.55' : '.9'}"><title>${escape(sampleLabel(check))}</title></rect>`).join('')}</svg></div>`;
}
function renderChart(monitor) {
  const element = $('#latency-chart');
  const checks = historyOf(monitor, state.range);
  $('#chart-sample-count').textContent = `${checks.length} sample${checks.length === 1 ? '' : 's'}`;
  $('#availability-label').textContent = `Last ${state.range} hour${state.range === 1 ? '' : 's'} · ${checks.length} checks`;
  replaceContent($('#selected-availability'), availabilityHTML(checks));
  if (!monitor || !checks.length) {
    replaceContent(element, empty(monitor ? 'No samples in this time range.' : 'No monitor selected.', monitor ? 'Try a wider range, or run an eligible monitor in its matching mode.' : 'Create or select a monitor to view its history.'));
    return;
  }
  const now = state.data.now;
  const start = now - state.range * 3600000;
  // Match the SVG's coordinate width to the panel so mobile labels stay readable.
  const w = Math.max(300, Math.min(900, element.clientWidth ? element.clientWidth - 24 : 680));
  const h = 260, left = 51, right = 16, top = 24, bottom = 37;
  const plotWidth = w - left - right, plotHeight = h - top - bottom;
  const maxValue = Math.max(100, finite(monitor.slowThresholdMs) ? monitor.slowThresholdMs : 0, ...checks.map((check) => finite(check.latencyMs) ? Math.max(0, check.latencyMs) : 0));
  const maximum = Math.ceil(maxValue * 1.15 / 100) * 100;
  const x = (at) => left + (at - start) / (now - start) * plotWidth;
  const y = (value) => top + plotHeight - Math.max(0, value) / maximum * plotHeight;
  const points = checks.filter((check) => finite(check.latencyMs)).map((check) => ({ check, x: x(check.at), y: y(check.latencyMs) }));
  const segments = [];
  let segment = [];
  for (const point of points) {
    if (point.check.ok) segment.push(point);
    else if (segment.length) { segments.push(segment); segment = []; }
  }
  if (segment.length) segments.push(segment);
  const paths = segments.map((part) => {
    const path = part.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
    return `<path d="${path} L${part.at(-1).x.toFixed(2)} ${top + plotHeight} L${part[0].x.toFixed(2)} ${top + plotHeight} Z" fill="url(#latency-fill)"/><path d="${path}" class="chart-line"/>`;
  }).join('');
  const yLabels = Array.from({ length: 5 }, (_, index) => {
    const value = maximum * index / 4;
    const pos = y(value);
    return `<line class="chart-gridline" x1="${left}" x2="${w - right}" y1="${pos}" y2="${pos}"/><text class="chart-label" x="${left - 9}" y="${pos + 3}" text-anchor="end">${escape(number(value))}</text>`;
  }).join('');
  const xLabels = Array.from({ length: 5 }, (_, index) => {
    const at = start + (now - start) * index / 4;
    return `<text class="chart-label" x="${x(at)}" y="${h - 12}" text-anchor="${index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}">${escape(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</text>`;
  }).join('');
  const threshold = finite(monitor.slowThresholdMs) ? `<line class="chart-threshold" x1="${left}" x2="${w - right}" y1="${y(monitor.slowThresholdMs)}" y2="${y(monitor.slowThresholdMs)}"><title>Configured slow threshold: ${escape(latency(monitor.slowThresholdMs))}</title></line>` : '';
  const samples = points.map((point, index) => `<circle class="chart-sample" data-sample="${escape(sampleLabel(point.check))}" data-sample-index="${index}" data-focus-key="sample:${escape(point.check.id)}" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${point.check.ok ? '3' : '4'}" fill="${point.check.ok ? 'var(--accent)' : 'var(--red)'}" stroke="var(--surface)" stroke-width="1" tabindex="${index === points.length - 1 ? '0' : '-1'}" role="img" aria-label="${escape(sampleLabel(point.check))}"><title>${escape(sampleLabel(point.check))}</title></circle>`).join('');
  replaceContent(element, `<svg viewBox="0 0 ${w} ${h}" role="group" aria-labelledby="chart-svg-title chart-svg-description"><title id="chart-svg-title">${escape(monitor.name)} response-header latency over ${state.range} hours</title><desc id="chart-svg-description">Milliseconds on the vertical axis; local time on the horizontal axis. Lime samples succeeded, red samples failed. Dashed amber line is the configured slow threshold. Focus a sample and use left and right arrow keys to inspect history. Successful lines break at failures.</desc><defs><linearGradient id="latency-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#d5ff70" stop-opacity=".15"/><stop offset="100%" stop-color="#d5ff70" stop-opacity="0"/></linearGradient></defs><text class="chart-label" x="${left - 9}" y="11" text-anchor="end">ms</text>${yLabels}${xLabels}${threshold}${paths}${samples}</svg><div class="chart-tooltip" id="chart-tooltip">Hover a sample, or focus it and use ← / → to inspect checks.</div>`);
}
function renderOrbit() {
  if (!state.data) return;
  const summary = state.data.summary;
  const health = !state.online ? 'unknown' : isPublic ? ({ operational: 'up', outage: 'down', degraded: 'degraded' }[state.data.overall] || 'unknown') : summary.down ? 'down' : summary.degraded ? 'degraded' : summary.up ? 'up' : 'unknown';
  sculpture.update({ health, online: state.online, mode: state.data.mode });
  if (isPublic) return;
  $('#orbit-health').textContent = !state.online ? 'CONNECTION LOST' : health === 'down' ? 'OUTAGE DETECTED' : health === 'degraded' ? 'SIGNAL DEGRADED' : health === 'up' ? 'SIGNALS HEALTHY' : 'NO ACTIVE SIGNALS';
  $('.core-label .tiny-dot', root).style.background = health === 'down' ? 'var(--red)' : health === 'degraded' ? 'var(--amber)' : health === 'up' ? 'var(--accent)' : 'var(--muted)';
  $('#orb-caption').textContent = !state.online ? 'Last received data · disconnected' : state.data.mode === 'demo' ? 'DEMO / SYNTHETIC SIGNALS' : 'LIVE / PUBLIC HTTP CHECKS';
  const monitors = state.data.monitors;
  const candidates = [selectedMonitor(), ...monitors.filter(m => m.status === 'down'), ...monitors.filter(m => m.status === 'degraded'), ...monitors];
  const shown = [...new Map(candidates.filter(Boolean).map(m => [m.id, m])).values()].slice(0, 3);
  replaceContent($('#signal-nodes'), shown.map(m => `<button class="signal-node ${Object.hasOwn(statuses, m.status) ? m.status : 'pending'}" type="button" data-select="${escape(m.id)}" data-focus-key="orbit:${escape(m.id)}" aria-pressed="${m.id === state.selectedId}" aria-label="Explore ${escape(m.name)}; ${escape(statuses[m.status] || 'Pending')}"><span class="node-mark">${icon('pulse')}</span><span class="node-copy"><strong>${escape(m.name)}</strong><small>${escape(statuses[m.status] || 'Pending')} · ${escape(latency(m.latencyMs))}</small></span></button>`).join(''));
}
function renderSelection() {
  renderOrbit();
  const monitor = selectedMonitor();
  $('#chart-subtitle').textContent = monitor ? `${monitor.name} · ${monitor.kind === 'demo' ? 'synthetic demo checks' : 'HTTP check history'} · ${state.range}h` : 'Select a monitor to inspect its checks.';
  renderChart(monitor);
  const detail = $('#monitor-detail');
  if (!monitor) { replaceContent(detail, empty('No monitor selected.', 'Add your first monitor to begin.', 'monitor')); return; }
  const history = [...(monitor.history || [])].reverse().sort((a, b) => b.at - a.at);
  const latest = history[0];
  const url = safeURL(monitor.url);
  const active = compatible(monitor) && monitor.enabled;
  const busy = state.busy.get(monitor.id);
  const blocked = !state.online || Boolean(busy) || state.modeBusy;
  const link = url && !isHostedDemo ? `<a class="detail-url" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(monitor.url)}${icon('arrow', 'small')}</a>` : `<span class="detail-url">${escape(monitor.url)}</span>`;
  const modeHint = !compatible(monitor) ? `<p class="mode-hint">${monitor.kind === 'http' ? 'HTTP checks only run in Live mode. This monitor is paused in Demo.' : 'Seeded demo checks only run in Demo mode. This monitor is paused in Live.'}</p><button type="button" class="text-button" data-mode="${monitor.kind === 'http' ? 'live' : 'demo'}">Switch to ${monitor.kind === 'http' ? 'Live' : 'Demo'} explicitly${icon('arrow', 'small')}</button>` : '';
  replaceContent(detail, `<div class="detail-content"><div class="detail-topline"><span class="kind-label">${monitor.kind === 'demo' ? 'SYNTHETIC DEMO' : 'HTTP ENDPOINT'}</span>${pill(monitor.status)}</div><h3 class="detail-name">${escape(monitor.name)}</h3>${link}<div class="detail-metrics"><div class="detail-metric"><span>Latest header latency</span><strong>${finite(monitor.latencyMs) ? `${escape(number(monitor.latencyMs))}<small>ms</small>` : '—'}</strong></div><div class="detail-metric"><span>Sampled uptime · 24h</span><strong>${finite(monitor.uptime24h) ? `${escape(number(monitor.uptime24h, 2))}<small>%</small>` : '—'}</strong></div></div><dl class="detail-facts"><div><dt>Latest result</dt><dd>${latest ? latest.ok ? 'Successful' : 'Failed' : '—'}</dd></div><div><dt>HTTP response</dt><dd>${latest?.statusCode != null ? escape(latest.statusCode) : '—'}</dd></div><div><dt>Attempts</dt><dd>${latest ? escape(number(latest.attempts)) : '—'}</dd></div><div><dt>P95 · 24h</dt><dd>${escape(latency(monitor.p95LatencyMs))}</dd></div><div><dt>Last checked</dt><dd title="${escape(dateTime(monitor.lastCheckedAt))}">${escape(clock(monitor.lastCheckedAt))}</dd></div><div><dt>Next check</dt><dd title="${active ? escape(dateTime(monitor.nextCheckAt)) : ''}">${isHostedDemo ? 'Manual samples only' : active ? escape(clock(monitor.nextCheckAt)) : '—'}</dd></div><div><dt>Interval / timeout</dt><dd>${escape(number(monitor.intervalSeconds))}s / ${escape(latency(monitor.timeoutMs))}</dd></div><div><dt>Slow threshold</dt><dd>${escape(latency(monitor.slowThresholdMs))}</dd></div></dl>${latest?.error ? `<p class="check-error">${escape(latest.error)}</p>` : ''}${modeHint}<div class="detail-actions"><button class="button secondary compact" type="button" data-monitor-action="check" data-monitor-id="${escape(monitor.id)}" data-focus-key="check:${escape(monitor.id)}" ${blocked || !active ? 'disabled' : ''}>${icon('refresh')}${busy === 'check' ? 'Checking…' : 'Check now'}</button><button class="button secondary compact" type="button" data-monitor-action="toggle" data-monitor-id="${escape(monitor.id)}" data-focus-key="toggle:${escape(monitor.id)}" ${blocked || !compatible(monitor) ? 'disabled' : ''}>${icon(monitor.enabled ? 'pause' : 'play')}${busy === 'toggle' ? 'Saving…' : monitor.enabled ? 'Pause' : 'Resume'}</button><button type="button" class="icon-button delete-button" data-monitor-action="delete" data-monitor-id="${escape(monitor.id)}" data-focus-key="delete:${escape(monitor.id)}" ${blocked ? 'disabled' : ''} aria-label="Delete ${escape(monitor.name)}" title="Delete monitor">${icon('trash')}</button></div>${busy === 'check' ? '<p class="mode-hint">Checking with retries. This may take about 30 seconds.</p>' : ''}</div><div class="recent-checks"><h3>RECENT CHECKS · ${Math.min(history.length, 4)} SAMPLES</h3><div>${history.slice(0, 4).map((check) => `<div class="recent-check-row" title="${escape(sampleLabel(check))}"><span class="check-dot${check.ok ? '' : ' failed'}"></span>${timeMarkup(check.at, true)}<span>${escape(latency(check.latencyMs))}</span></div>`).join('') || '<p class="muted small-text">No checks recorded yet.</p>'}</div></div>`);
}
function renderIncidents(element, incidents) {
  const sorted = [...incidents].sort((a, b) => (a.status === 'investigating' ? 0 : 1) - (b.status === 'investigating' ? 0 : 1) || b.startedAt - a.startedAt);
  if (!sorted.length) { replaceContent(element, empty('No incidents recorded.', 'Quiet is a good signal.', 'check')); return; }
  replaceContent(element, sorted.map((incident) => `<details class="incident-card" data-incident-id="${escape(incident.id)}"><summary data-focus-key="incident:${escape(incident.id)}" aria-label="${escape(incident.title)}; ${escape(incident.status)}; expand event history"><span class="incident-summary-text"><strong>${escape(incident.title)}</strong><small>${escape(incident.monitorName)} · ${escape(dateTime(incident.startedAt))}</small></span>${pill(incident.status)}</summary><div class="incident-duration"><span>${incident.status === 'resolved' ? 'Resolved' : 'Open'} · ${escape(duration(incident.durationMs))}</span><span>${incident.resolvedAt != null ? escape(dateTime(incident.resolvedAt)) : 'Investigating'}</span></div><ol class="incident-events">${(incident.events || []).map((event) => `<li>${escape(event.message)}${timeMarkup(event.at)}</li>`).join('') || '<li>No event details available.</li>'}</ol></details>`).join(''));
}
function activityKind(type) {
  if (/resolv|recover|creat|resum|success/i.test(type)) return ['check', 'good'];
  if (/outage|incident.open|fail|down|delet/i.test(type)) return ['incident', 'bad'];
  if (/paus/i.test(type)) return ['pause', ''];
  if (/latency|slow/i.test(type)) return ['clock', ''];
  return ['pulse', ''];
}
function renderActivity(element, activity) {
  if (!activity.length) { replaceContent(element, `<li>${empty('No activity yet.', 'Check results and changes will appear here.', 'clock')}</li>`); return; }
  const items = [...activity].sort((a, b) => b.at - a.at).slice(0, 30);
  replaceContent(element, items.map((item) => {
    const [symbol, color] = activityKind(item.type || '');
    return `<li class="activity-item"><span class="activity-symbol ${color}">${icon(symbol)}</span><div class="activity-copy"><p>${escape(item.message)}</p>${timeMarkup(item.at)}</div></li>`;
  }).join(''));
}
function renderPublic() {
  const { name, overall, components, incidents = [], uptime24h, now } = state.data;
  renderMode();
  renderOrbit();
  document.title = `${name || 'Pulse'} · Public status`;
  $('#public-name').textContent = name || 'System status';
  $('#public-updated-at').textContent = `Synced ${clock(now)}`;
  const labels = { operational: 'All systems operational', degraded: 'Some systems are degraded', outage: 'Service outage detected', unknown: 'No active service status' };
  const descriptions = { operational: 'No degraded or down components reported.', degraded: 'At least one component is responding slowly or has reduced availability.', outage: 'At least one component is reporting failed checks.' };
  const section = $('#public-overall');
  section.className = `public-overall panel ${['operational', 'degraded', 'outage'].includes(overall) ? overall : ''}`;
  replaceContent(section, `<span class="overall-symbol">${icon(overall === 'operational' ? 'check' : 'incident')}</span><div><div class="eyebrow">${state.data.mode === 'demo' ? 'DEMONSTRATION STATUS' : 'CURRENT STATUS'}</div><h2>${escape(labels[overall] || 'Status unknown')}</h2><p>${escape(descriptions[overall] || 'Awaiting confirmed status.')}${components.length && components.every((component) => ['paused', 'pending'].includes(component.status)) ? ' No components have active results; see paused/pending labels below.' : ''}${!components.length ? ' No components configured.' : ''}</p></div><div class="overall-uptime"><strong>${escape(percentage(uptime24h))}</strong><small>Successful sampled checks · 24h</small></div>`);
  replaceContent($('#public-components'), components.length ? components.map((component) => {
    const checks = historyOf(component);
    return `<article class="panel component-card"><div class="component-heading"><h3>${escape(component.name)}</h3>${pill(component.status)}</div><div class="component-stats"><span>Sampled uptime · 24h</span><strong>${escape(percentage(component.uptime24h))}</strong></div>${availabilityHTML(checks)}<div class="component-footer"><span>${checks.length} checks · green = success</span><span title="${escape(dateTime(component.lastCheckedAt))}">Last check ${escape(clock(component.lastCheckedAt))}</span></div></article>`;
  }).join('') : `<div class="panel">${empty('No components configured.', 'There is no measured service health to display.', 'monitor')}</div>`);
  renderIncidents($('#public-incidents'), incidents);
  const events = incidents.flatMap((incident) => (incident.events || []).map((event, index) => ({ id: `${incident.id}:${index}`, at: event.at, type: event.type, message: `${incident.monitorName}: ${event.message}` })));
  renderActivity($('#public-timeline'), events);
}
function updateActionAvailability() {
  if (isPublic) return;
  $$('[data-mode]').forEach((button) => { button.disabled = (isHostedDemo && button.dataset.mode === 'live') || !state.online || state.modeBusy || state.scenarioBusy || state.createBusy || state.busy.size > 0; });
  $('#create-switch-live').disabled = isHostedDemo || !state.online || state.modeBusy || state.scenarioBusy || state.createBusy || state.busy.size > 0;
  $$('[data-reset-demo]').forEach(button => { button.disabled = !state.online || state.scenarioBusy || state.createBusy || state.busy.size > 0; });
  $$('[data-scenario]', root).forEach((button) => { button.disabled = !state.online || state.data?.mode !== 'demo' || !state.data?.monitors.some((monitor) => monitor.kind === 'demo') || state.scenarioBusy || state.modeBusy || state.busy.size > 0; });
  $('#create-submit').disabled = state.createBusy || !state.online || state.modeBusy;
  const deletingMonitorExists = state.data?.monitors.some((monitor) => monitor.id === state.deletingId);
  $('#delete-submit').disabled = !state.online || state.modeBusy || !deletingMonitorExists || Boolean(state.busy.get(state.deletingId));
  if ($('#delete-dialog').open && !deletingMonitorExists) formError('delete-error', new Error('This monitor is no longer available. It may have already been deleted.'));
  $('#mode-confirm').disabled = !state.online || state.modeBusy;
  $$('[data-monitor-action]', root).forEach((button) => {
    const monitor = state.data?.monitors.find((item) => item.id === button.dataset.monitorId);
    button.disabled = !state.online || !monitor || state.modeBusy || state.scenarioBusy || state.busy.has(monitor.id) || (button.dataset.monitorAction !== 'delete' && !compatible(monitor)) || (button.dataset.monitorAction === 'check' && !monitor.enabled);
  });
}
function openDialog(id, opener, focusSelector) {
  const dialog = $(`#${id}`);
  if (dialog.open) return;
  dialogOpeners.set(id, opener || document.activeElement);
  dialog.showModal();
  if (focusSelector) $(focusSelector, dialog)?.focus({ preventScroll: true });
}
function clearError(id) { const element = $(`#${id}`); element.hidden = true; element.textContent = ''; }
function formError(id, error) { const element = $(`#${id}`); element.textContent = error.message; element.hidden = false; }
function openCreate(opener) {
  clearError('create-error');
  $('#create-demo-note').hidden = state.data?.mode !== 'demo';
  updateActionAvailability();
  openDialog('create-dialog', opener, '#monitor-name');
}
function requestMode(mode, opener) {
  if (isHostedDemo && mode === 'live') { toast('Real HTTP monitoring requires the local Node app. This hosted demo only generates synthetic samples.'); return; }
  if (isPublic || !state.online || state.modeBusy || mode === state.data?.mode || !['demo', 'live'].includes(mode)) return;
  state.pendingMode = mode;
  $('#mode-title').textContent = `Switch to ${mode === 'live' ? 'Live' : 'Demo'} mode?`;
  $('#mode-description').textContent = mode === 'live' ? 'Live mode makes real network requests to your enabled public HTTP endpoints. Seeded demo monitors will pause. Your monitors and historical data are preserved; this does not reset the workspace.' : 'Demo mode pauses real HTTP checks and activates enabled seeded demo monitors. Charts for demo monitors include synthetic history. Scenario controls affect no real site. Your data is preserved.';
  $('#mode-confirm').textContent = `Switch to ${mode === 'live' ? 'Live' : 'Demo'}`;
  clearError('mode-error');
  openDialog('mode-dialog', opener, '#mode-confirm');
}
async function changeMode() {
  const mode = state.pendingMode;
  if (state.modeBusy || !state.online || !mode) return;
  state.modeBusy = true;
  updateActionAvailability();
  try {
    await api('/api/settings', { method: 'POST', body: { mode } });
    $('#mode-dialog').close();
    await refresh();
    toast(`Switched to ${mode === 'live' ? 'Live' : 'Demo'} mode. Historical data preserved.`);
  } catch (error) { formError('mode-error', error); }
  finally { state.modeBusy = false; updateActionAvailability(); if (state.data) renderSelection(); }
}
async function runMonitorAction(action, id, opener) {
  const monitor = state.data?.monitors.find((item) => item.id === id);
  if (!monitor || !state.online || state.busy.has(id) || state.modeBusy || state.scenarioBusy) return;
  if (action === 'delete') {
    state.deletingId = id;
    $('#delete-monitor-name').textContent = monitor.name;
    clearError('delete-error');
    updateActionAvailability();
    openDialog('delete-dialog', opener, '[data-close-dialog="delete-dialog"]');
    return;
  }
  if (!compatible(monitor) || (action === 'check' && !monitor.enabled)) { toast('This monitor is paused or incompatible with the current mode.', true); return; }
  state.busy.set(id, action);
  renderSelection();
  updateActionAvailability();
  if (action === 'check') announce(`Checking ${monitor.name}. Retries may take about 30 seconds.`);
  try {
    const base = `/api/monitors/${encodeURIComponent(id)}`;
    const response = await api(action === 'check' ? `${base}/check` : base, { method: action === 'check' ? 'POST' : 'PATCH', body: action === 'check' ? {} : { enabled: !monitor.enabled }, timeout: action === 'check' ? 45000 : 12000 });
    await refresh();
    toast(action === 'check' ? `${monitor.name}: ${response.check?.ok ? 'check succeeded' : 'check failed'} · ${latency(response.check?.latencyMs)}` : `${monitor.name} ${monitor.enabled ? 'paused' : 'resumed'}.`);
  } catch (error) { toast(error.message, true); await refresh(); }
  finally { state.busy.delete(id); if (state.data) renderSelection(); updateActionAvailability(); }
}
async function createMonitor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (state.createBusy || !form.reportValidity()) return;
  if (!state.online) { formError('create-error', new Error('Reconnect to the local server before creating a monitor.')); return; }
  const values = new FormData(form);
  const name = String(values.get('name') || '').trim();
  const url = String(values.get('url') || '').trim();
  const normalizedURL = safeURL(url);
  if (!name || !normalizedURL) { formError('create-error', new Error('Enter a name and a valid HTTP or HTTPS URL without embedded credentials.')); return; }
  const body = { name, url: normalizedURL, intervalSeconds: Number(values.get('intervalSeconds')), timeoutMs: Number(values.get('timeoutMs')), slowThresholdMs: Number(values.get('slowThresholdMs')) };
  const rules = [['intervalSeconds', 15, 3600], ['timeoutMs', 1000, 15000], ['slowThresholdMs', 100, 10000]];
  if (rules.some(([field, min, max]) => !Number.isInteger(body[field]) || body[field] < min || body[field] > max)) { formError('create-error', new Error('Timing values must be whole numbers within the displayed limits.')); return; }
  state.createBusy = true;
  clearError('create-error');
  $$('input', form).forEach((input) => { input.disabled = true; });
  $('#create-submit').textContent = 'Creating…';
  updateActionAvailability();
  try {
    const response = await api('/api/monitors', { method: 'POST', body });
    state.selectedId = response.monitor.id;
    state.filter = 'all'; state.search = '';
    $('#monitor-search').value = '';
    updateFilters();
    $('#create-dialog').close();
    form.reset();
    await refresh();
    toast(isHostedDemo ? `${name}: synthetic signal created. Use Check now to generate samples; no network requests are made.` : `${name} created.${state.data?.mode === 'demo' ? ' HTTP checks remain paused in Demo mode.' : ' Live checks will run on schedule.'}`);
  } catch (error) { formError('create-error', error); if (!$('#create-dialog').open) toast(error.message, true); }
  finally {
    state.createBusy = false;
    $$('input', form).forEach((input) => { input.disabled = false; });
    $('#create-submit').innerHTML = `${icon('plus')}Create monitor`;
    updateActionAvailability();
  }
}
async function deleteMonitor(event) {
  event.preventDefault();
  const id = state.deletingId;
  const monitor = state.data?.monitors.find((item) => item.id === id);
  if (!monitor || !state.online || state.busy.has(id)) return;
  state.busy.set(id, 'delete');
  clearError('delete-error');
  $('#delete-submit').textContent = 'Deleting…';
  updateActionAvailability();
  try {
    await api(`/api/monitors/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
    $('#delete-dialog').close();
    if (state.selectedId === id) state.selectedId = null;
    await refresh();
    toast(`${monitor.name} deleted.`);
  } catch (error) { formError('delete-error', error); if (!$('#delete-dialog').open) toast(error.message, true); }
  finally { state.busy.delete(id); $('#delete-submit').textContent = 'Delete monitor'; updateActionAvailability(); if (state.data) renderSelection(); }
}
async function runScenario(scenario) {
  if (!state.online || state.data?.mode !== 'demo' || state.scenarioBusy || state.modeBusy || state.busy.size || !['outage', 'recovery', 'latency'].includes(scenario)) return;
  state.scenarioBusy = true;
  updateActionAvailability();
  const button = $(`[data-scenario="${scenario}"]`, root);
  const original = button.innerHTML;
  button.textContent = 'Applying scenario…';
  try {
    await api('/api/demo/scenario', { method: 'POST', body: { scenario }, timeout: 45000 });
    const firstDemo = state.data.monitors.find((monitor) => monitor.kind === 'demo');
    if (firstDemo) state.selectedId = firstDemo.id;
    await refresh();
    toast(`${scenario === 'outage' ? 'Demo outage simulated' : scenario === 'recovery' ? 'Demo recovered' : 'Slow demo response simulated'}. No real site was affected.`);
  } catch (error) { toast(error.message, true); await refresh(); }
  finally { state.scenarioBusy = false; button.innerHTML = original; updateActionAvailability(); }
}
async function resetHostedDemo() {
  if (!isHostedDemo || !state.online || state.scenarioBusy || state.createBusy || state.busy.size) return;
  state.scenarioBusy = true;
  updateActionAvailability();
  try {
    await api('/api/demo/reset', { method: 'POST', body: {} });
    state.selectedId = null; state.filter = 'all'; state.search = '';
    $('#monitor-search').value = '';
    updateFilters();
    await refresh();
    toast('Synthetic demo reset in this tab. No local app data was changed.');
  } catch (error) { toast(error.message, true); }
  finally { state.scenarioBusy = false; updateActionAvailability(); }
}
function updateFilters() { $$('[data-filter]', root).forEach((button) => { button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)); }); }
function navigate(sectionId) {
  const section = $(`#${sectionId}`);
  if (!section) return;
  $$('[data-nav]', root).forEach((link) => {
    const active = link.dataset.nav === sectionId;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  $('#breadcrumb-current').textContent = sectionId[0].toUpperCase() + sectionId.slice(1);
  history.replaceState(null, '', `#${sectionId}`);
  section.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  const heading = $('h1, h2', section);
  if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
}
root.addEventListener('click', (event) => {
  const target = event.target.closest('button, a[data-nav]');
  if (!target) return;
  if (target.matches('[data-toggle-motion]')) {
    motionPaused = !motionPaused;
    try { sessionStorage.setItem('pulse:motion-paused', String(motionPaused)); } catch { /* Storage is optional. */ }
    syncMotion();
    return;
  }
  if (target.matches('[data-retry]')) {
    setConnection('reconnecting', 'Resyncing with local server');
    startBackground(); refresh(); return;
  }
  if (isPublic) return;
  if (target.matches('[data-nav]')) { event.preventDefault(); navigate(target.dataset.nav); }
  else if (target.matches('[data-open-create]')) openCreate(target);
  else if (target.matches('[data-mode]')) requestMode(target.dataset.mode, target);
  else if (target.matches('[data-scenario]')) runScenario(target.dataset.scenario);
  else if (target.matches('[data-reset-demo]')) resetHostedDemo();
  else if (target.matches('[data-select]')) {
    state.selectedId = target.dataset.select;
    renderMonitorList(); renderSelection(); updateActionAvailability();
    announce(`Selected ${selectedMonitor()?.name || 'monitor'}. Chart and details updated.`);
  } else if (target.matches('[data-range]')) {
    state.range = Number(target.dataset.range);
    $$('[data-range]', root).forEach((button) => { button.setAttribute('aria-pressed', String(Number(button.dataset.range) === state.range)); });
    if (state.data) renderSelection();
    announce(`Showing ${state.range} hours of sampled check history.`);
  } else if (target.matches('[data-filter]')) {
    state.filter = target.dataset.filter;
    updateFilters();
    if (state.data) renderMonitorList();
  } else if (target.matches('[data-clear-search]')) {
    state.filter = 'all'; state.search = ''; $('#monitor-search').value = '';
    updateFilters(); renderMonitorList(); $('#monitor-search').focus();
  } else if (target.matches('[data-monitor-action]')) runMonitorAction(target.dataset.monitorAction, target.dataset.monitorId, target);
});
if (!isPublic) {
  $('#monitor-search').addEventListener('input', (event) => { state.search = event.target.value; if (state.data) renderMonitorList(); });
  $('#create-form').addEventListener('submit', createMonitor);
  $('#delete-form').addEventListener('submit', deleteMonitor);
  $('#mode-confirm').addEventListener('click', changeMode);
  $('#create-switch-live').addEventListener('click', (event) => requestMode('live', event.currentTarget));
  $$('[data-close-dialog]').forEach((button) => { button.addEventListener('click', () => $(`#${button.dataset.closeDialog}`).close()); });
  $$('dialog').forEach((dialog) => {
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const controls = $$('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]', dialog).filter((element) => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    });
    dialog.addEventListener('close', () => {
      const opener = dialogOpeners.get(dialog.id);
      dialogOpeners.delete(dialog.id);
      const replacement = opener?.dataset.focusKey ? $$('[data-focus-key]', root).find((item) => item.dataset.focusKey === opener.dataset.focusKey) : null;
      const usable = (element) => element?.isConnected && !element.disabled && element.getClientRects().length > 0;
      const activeDialog = $('dialog[open]');
      const fallback = activeDialog ? $('input:not(:disabled), button:not(:disabled)', activeDialog) : $('[data-open-create]', root);
      const focusTarget = usable(opener) ? opener : usable(replacement) ? replacement : fallback;
      focusTarget?.focus({ preventScroll: true });
    });
  });
  document.addEventListener('keydown', (event) => {
    const editable = event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    if (editable || event.altKey || event.ctrlKey || event.metaKey || $$('dialog[open]').length) return;
    if (event.key === '/') { event.preventDefault(); $('#monitor-search').focus(); $('#monitor-search').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    else if (event.key.toLowerCase() === 'n') { event.preventDefault(); openCreate(document.activeElement); }
  });
  const chart = $('#latency-chart');
  if (typeof ResizeObserver !== 'undefined') {
    let chartWidth = 0;
    let resizeTimer;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (!width || width === chartWidth) return;
      chartWidth = width;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (pageActive && !document.hidden && state.data) renderChart(selectedMonitor());
      }, 100);
    });
    observer.observe(chart);
  }
  function showSample(event) {
    const sample = event.target.closest('[data-sample]');
    if (sample && $('#chart-tooltip')) $('#chart-tooltip').textContent = sample.dataset.sample;
  }
  chart.addEventListener('pointerover', showSample);
  chart.addEventListener('focusin', showSample);
  chart.addEventListener('pointerout', (event) => {
    if (!event.relatedTarget || !chart.contains(event.relatedTarget)) {
      const current = document.activeElement?.matches('[data-sample]') ? document.activeElement : null;
      if ($('#chart-tooltip')) $('#chart-tooltip').textContent = current?.dataset.sample || 'Hover a sample, or focus it and use left / right arrows to inspect checks.';
    }
  });
  chart.addEventListener('keydown', (event) => {
    const sample = event.target.closest('[data-sample]');
    if (!sample || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const samples = $$('[data-sample]', chart);
    const index = samples.indexOf(sample);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? samples.length - 1 : Math.min(samples.length - 1, Math.max(0, index + (event.key === 'ArrowRight' ? 1 : -1)));
    samples.forEach((item) => { item.setAttribute('tabindex', '-1'); });
    samples[next].setAttribute('tabindex', '0'); samples[next].focus();
  });
  document.title = 'Pulse · Workspace overview';
} else {
  document.title = 'Pulse · Public status';
  $('.skip-link').href = '#public-main';
  // Hidden admin dialogs have no handlers, and public data never requests the dashboard endpoint.
  $$('dialog').forEach((dialog) => { dialog.hidden = true; });
}
function suspendReads() {
  lifecycle += 1;
  readController?.abort();
  readController = null;
  refreshPromise = null;
  refreshQueued = false;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopBackground(); suspendReads(); updateConnection(); }
  else if (pageActive) { startBackground(); refresh(); }
});
window.addEventListener('pagehide', () => {
  pageActive = false;
  if (lightFrame) { cancelAnimationFrame(lightFrame); lightFrame = null; }
  stopBackground(); suspendReads();
});
window.addEventListener('pageshow', () => {
  if (!pageActive) { pageActive = true; startBackground(); refresh(); }
});
updateActionAvailability();
startBackground();
refresh();
