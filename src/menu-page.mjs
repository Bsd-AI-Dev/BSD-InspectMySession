// The menu around the session pages. Left: three tabs, Sessions (grouped by project), Settings (how questions
// are asked) and Ask log (every question, with a cost popup). Right: the chosen session page, the unchanged
// show-context page, loaded in a frame from s/<id>/.

const CSS = `
:root {
  color-scheme: dark;
  --bg: #161615; --side: #1f1f1d; --text: #ececea; --muted: #9b9b95; --line: #33332f;
  --hover: #2a2a27; --pick: #22324d; --pick-line: #7aa2f7; --button: #262624; --danger: #f97066;
}
:root[data-theme='light'] {
  color-scheme: light;
  --bg: #f6f6f3; --side: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e3de;
  --hover: #f0f0eb; --pick: #e6eefb; --pick-line: #3b6fd8; --button: #ffffff; --danger: #b42318;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; }
body {
  display: flex; background: var(--bg); color: var(--text);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
aside {
  width: 360px; min-width: 260px; max-width: 45vw; resize: horizontal; overflow: hidden;
  display: flex; flex-direction: column; background: var(--side); border-right: 1px solid var(--line);
}
header { padding: 12px 12px 8px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.top h1 { font-size: 14px; margin: 0; flex: 1 0 100%; font-weight: 600; }
.top button { white-space: nowrap; }
.top h1 span { color: var(--muted); font-weight: 400; font-size: 12px; }
button {
  font: inherit; color: var(--text); background: var(--button); border: 1px solid var(--line);
  border-radius: 6px; padding: 3px 8px; cursor: pointer;
}
button:hover { background: var(--hover); }
#stop { color: var(--danger); }
.tabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--line); }
.tabs button {
  border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none;
  padding: 7px 10px 6px; color: var(--muted);
}
.tabs button:hover { color: var(--text); background: none; }
.tabs button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--pick-line); font-weight: 600; }
.panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.filters { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
input, select {
  font: inherit; color: var(--text); background: var(--button); border: 1px solid var(--line);
  border-radius: 6px; padding: 5px 8px;
}
input[type="checkbox"] { padding: 0; }
.filters input { flex: 1; min-width: 0; }
#sessions { flex: 1; overflow-y: auto; padding: 4px 0 12px; }
#panel-settings { overflow-y: auto; padding: 12px; gap: 16px; }
.field { display: grid; gap: 4px; min-width: 0; }
.field > select, .field > input { width: 100%; min-width: 0; }
.field > label, .field > .label { font-weight: 600; }
.field .row { display: flex; gap: 6px; align-items: center; }
.hint { color: var(--muted); font-size: 12px; margin: 0; }
.save-row { display: flex; gap: 10px; align-items: center; }
#settings-save { padding: 5px 14px; }
#settings-status { color: var(--muted); font-size: 12px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); font-size: 12px; }
th { color: var(--muted); font-weight: 500; }
td.n, th.n { text-align: right; }
#asks { flex: 1; overflow-y: auto; padding: 4px 6px 12px; }
.ask-row {
  all: unset; box-sizing: border-box; width: 100%; display: grid; gap: 2px; padding: 6px 8px;
  border-radius: 6px; cursor: pointer;
}
.ask-row:hover { background: var(--hover); }
.ask-row:focus-visible { outline: 2px solid var(--pick-line); }
.ask-row .q { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ask-row .meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.state-cancelled, .state-timeout { color: var(--muted); }
.state-error { color: var(--danger); }
dialog {
  width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow-y: auto;
  background: var(--side); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px;
}
dialog::backdrop { background: rgba(0, 0, 0, 0.45); }
dialog h2 { font-size: 15px; margin: 0 0 12px; }
dialog dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; margin: 0 0 14px; }
dialog dt { color: var(--muted); }
dialog dd { margin: 0; overflow-wrap: anywhere; }
dialog .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.project > summary {
  list-style: none; cursor: pointer; padding: 8px 12px 4px; display: flex; gap: 6px; align-items: baseline;
  position: sticky; top: 0; background: var(--side); z-index: 1;
}
.project > summary::-webkit-details-marker { display: none; }
.project > summary::before { content: '▾'; color: var(--muted); width: 10px; }
.project:not([open]) > summary::before { content: '▸'; }
.project-name { font-weight: 600; }
.project-count { color: var(--muted); font-size: 12px; }
.session {
  display: flex; align-items: flex-start; gap: 4px; margin: 0 6px; border-radius: 6px;
  border-left: 3px solid transparent;
}
.session:hover { background: var(--hover); }
.session.selected { background: var(--pick); border-left-color: var(--pick-line); }
.session .open {
  all: unset; flex: 1; min-width: 0; padding: 6px 4px 6px 8px; cursor: pointer; display: grid; gap: 2px;
}
.session .open:focus-visible { outline: 2px solid var(--pick-line); border-radius: 4px; }
.session .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session .meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.session .copy { margin: 6px 6px 0 0; padding: 1px 6px; font-size: 11px; color: var(--muted); }
.status { padding: 8px 12px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); }
main { flex: 1; min-width: 0; display: flex; }
#frame { flex: 1; border: 0; width: 100%; height: 100%; background: var(--bg); }
.empty { margin: auto; color: var(--muted); text-align: center; padding: 24px; max-width: 420px; }
@media (max-width: 700px) {
  body { flex-direction: column; }
  aside { width: 100%; max-width: none; height: 45vh; resize: none; border-right: 0; border-bottom: 1px solid var(--line); }
}
`;

// Runs in <head> so the page never flashes in the wrong theme. The key is shared with the session page.
const THEME_SCRIPT = `
function readTheme() {
  try { return localStorage.getItem('show-context-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}
document.documentElement.dataset.theme = readTheme();
`;

const SCRIPT = `
const $ = id => document.getElementById(id);
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme').textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
  // The session page in the frame sees this change through the storage event and follows it.
  try { localStorage.setItem('show-context-theme', theme); } catch {}
}
setTheme(readTheme());
$('theme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
const params = new URLSearchParams(location.search);
let selected = params.get('session') || '';
let projects = [];

function when(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function size(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(bytes / 1024)) + 'KB';
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function status(text) { $('status').textContent = text; }
function money(value) { return '$' + Number(value || 0).toFixed(4); }
function count(value) { return Number(value || 0).toLocaleString('en-US'); }

// ---- Tabs
const TABS = ['sessions', 'settings', 'log'];
function showTab(name) {
  for (const tab of TABS) {
    const selectedTab = tab === name;
    $('tab-' + tab).setAttribute('aria-selected', String(selectedTab));
    $('tab-' + tab).tabIndex = selectedTab ? 0 : -1;
    $('panel-' + tab).hidden = !selectedTab;
  }
  if (name === 'settings') loadSettings();
  if (name === 'log') loadAsks();
}
for (const tab of TABS) $('tab-' + tab).addEventListener('click', () => showTab(tab));

// ---- Settings
let prices = [];
function labelOf(model) {
  const price = prices.find(item => item.model === model);
  return price ? price.label : model;
}
async function loadSettings() {
  try {
    const data = await (await fetch('api/settings', { cache: 'no-store' })).json();
    prices = data.prices;
    const select = $('set-askModel');
    if (!select.dataset.filled) {
      for (const price of prices) select.insertBefore(new Option(price.label + ' (' + price.model + ')', price.model), $('other-option'));
      select.dataset.filled = '1';
    }
    const s = data.settings;
    const known = ['auto', 'session', ...prices.map(price => price.model)].includes(s.askModel);
    select.value = known ? s.askModel : 'other';
    $('set-askModel-other').value = known ? '' : s.askModel;
    $('set-askModel-other').hidden = known;
    $('set-cacheLifetime').value = s.cacheLifetime;
    $('set-costLimitUsd').value = String(s.costLimitUsd);
    $('set-askTimeoutMinutes').value = String(s.askTimeoutMinutes);
    $('set-keepQuestionText').checked = s.keepQuestionText;
    const rows = $('prices-body');
    rows.textContent = '';
    for (const price of prices) {
      const row = el('tr');
      row.append(el('td', '', price.label), el('td', 'n', '$' + price.input), el('td', 'n', '$' + price.cacheRead), el('td', 'n', '$' + price.output));
      rows.append(row);
    }
    $('prices-date').textContent = data.pricesUpdated;
  } catch {
    $('settings-status').textContent = 'The server is not reachable.';
  }
}
$('set-askModel').addEventListener('change', () => {
  $('set-askModel-other').hidden = $('set-askModel').value !== 'other';
});
$('settings-save').addEventListener('click', async () => {
  const model = $('set-askModel').value === 'other' ? $('set-askModel-other').value.trim() : $('set-askModel').value;
  const update = {
    askModel: model,
    cacheLifetime: $('set-cacheLifetime').value,
    costLimitUsd: Number($('set-costLimitUsd').value),
    askTimeoutMinutes: Number($('set-askTimeoutMinutes').value),
    keepQuestionText: $('set-keepQuestionText').checked
  };
  $('settings-status').textContent = 'Saving…';
  try {
    const response = await fetch('api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update)
    });
    const data = await response.json();
    $('settings-status').textContent = response.ok ? 'Saved' : data.error || 'Not saved.';
  } catch {
    $('settings-status').textContent = 'The server is not reachable.';
  }
});

// ---- Ask log
let asks = [];
const STATUS_TEXT = { answered: 'answered', cancelled: 'cancelled', timeout: 'timed out', error: 'error' };
async function loadAsks() {
  $('log-status').textContent = 'Loading…';
  try {
    if (!prices.length) prices = (await (await fetch('api/settings', { cache: 'no-store' })).json()).prices;
    asks = (await (await fetch('api/asks', { cache: 'no-store' })).json()).asks;
    renderAsks();
  } catch {
    $('log-status').textContent = 'The server is not reachable.';
  }
}
function renderAsks() {
  const list = $('asks');
  list.textContent = '';
  const words = $('log-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  asks.forEach((ask, index) => {
    const search = [ask.question, ask.text, ask.title, ask.project, ask.model, ask.sessionId, ask.status].join(' ').toLowerCase();
    if (!words.every(word => search.includes(word))) return;
    shown += 1;
    const row = el('button', 'ask-row');
    row.type = 'button';
    row.dataset.index = String(index);
    const state = el('span', 'state-' + ask.status, STATUS_TEXT[ask.status] || ask.status);
    const meta = el('span', 'meta', when(Date.parse(ask.time)) + ' · ' + (ask.model ? labelOf(ask.model) : '-') + ' · '
      + (ask.status === 'answered' ? money(ask.costUsd) : '-') + ' · ');
    meta.append(state);
    row.append(el('span', 'q', ask.question || (ask.kind === 'tool' ? 'Why was this called?' : '(question not kept)')),
      el('span', 'meta', ask.title || ask.sessionId.slice(0, 8)), meta);
    row.addEventListener('click', () => showAsk(ask));
    list.append(row);
  });
  if (!asks.length) list.append(el('p', 'empty', 'No questions yet. Select text in a session and click "Where did this come from?".'));
  $('log-status').textContent = shown === asks.length ? asks.length + ' questions, newest first' : shown + ' of ' + asks.length + ' questions';
}
function showAsk(ask) {
  const body = $('ask-detail-body');
  body.textContent = '';
  body.append(el('h2', '', ask.question || (ask.kind === 'tool' ? 'Why was this called?' : '(question not kept)')));
  const facts = el('dl');
  const fact = (name, value) => { if (value) facts.append(el('dt', '', name), el('dd', '', value)); };
  fact('Selected text', ask.text);
  fact('Session', (ask.title || '') + (ask.project ? ' (' + ask.project + ')' : '') + ' · ' + ask.sessionId.slice(0, 8));
  fact('Asked', when(Date.parse(ask.time)) + ' · took ' + ((ask.elapsedMs || 0) / 1000).toFixed(1) + ' s');
  fact('Result', (STATUS_TEXT[ask.status] || ask.status) + (ask.error ? ': ' + ask.error : '')
    + (ask.status === 'answered' ? ' · ' + (ask.found || 0) + ' source(s) found' : ''));
  fact('Model', ask.model ? labelOf(ask.model) + ' (' + ask.model + ')' : (ask.choice?.label || ''));
  fact('Why this model', ask.choice?.reason);
  const estimate = ask.choice?.estimate;
  if (estimate) {
    fact('Estimated before asking', 'about ' + money(estimate.sessionModelUsd) + ' with ' + (ask.choice.sessionLabel || ask.choice.sessionModel)
      + ', about ' + money(estimate.haikuUsd) + ' with ' + labelOf('claude-haiku-5-5'));
  }
  body.append(facts);
  if (ask.parts?.length) {
    const table = el('table');
    const head = el('tr');
    head.append(el('th', '', 'Tokens'), el('th', 'n', 'Count'), el('th', 'n', 'Cost'));
    table.append(head);
    for (const part of ask.parts) {
      const row = el('tr');
      row.append(el('td', '', part.label), el('td', 'n', count(part.tokens)), el('td', 'n', money(part.usd)));
      table.append(row);
    }
    const total = el('tr');
    total.append(el('th', '', 'Total reported by Claude Code'), el('th', 'n', ''), el('th', 'n', money(ask.costUsd)));
    table.append(total);
    body.append(table, el('p', 'hint', 'The parts are estimated from the price table in Settings; the total is what Claude Code reported. '
      + 'With a Claude subscription you are not charged this amount; it counts toward your usage limits.'));
  }
  $('ask-detail-open').onclick = () => {
    $('ask-detail').close();
    showTab('sessions');
    openSession(ask.sessionId);
  };
  $('ask-detail').showModal();
}
$('ask-detail-close').addEventListener('click', () => $('ask-detail').close());
$('log-filter').addEventListener('input', renderAsks);

function openSession(id, push) {
  selected = id;
  for (const row of document.querySelectorAll('.session')) row.classList.toggle('selected', row.dataset.id === id);
  const frame = $('frame');
  if (frame.getAttribute('src') !== 's/' + id + '/') frame.setAttribute('src', 's/' + id + '/');
  frame.hidden = false;
  $('empty').hidden = true;
  const next = new URL(location.href);
  next.searchParams.set('session', id);
  history.replaceState(null, '', next);
  const row = document.querySelector('.session[data-id="' + CSS.escape(id) + '"]');
  if (row) {
    row.closest('details').open = true;
    if (push !== false) row.scrollIntoView({ block: 'nearest' });
  }
}

function render() {
  const list = $('sessions');
  list.textContent = '';
  for (const project of projects) {
    const group = el('details', 'project');
    group.open = true;
    group.dataset.folder = project.folder;
    const summary = el('summary');
    summary.title = project.cwd || project.folder;
    summary.append(el('span', 'project-name', project.name), el('span', 'project-count', String(project.sessions.length)));
    group.append(summary);
    for (const session of project.sessions) {
      const row = el('div', 'session');
      row.dataset.id = session.id;
      row.dataset.source = session.source;
      row.dataset.search = [session.title, session.id, project.name, project.cwd, when(session.mtimeMs)].join(' ').toLowerCase();
      if (session.id === selected) row.classList.add('selected');
      const open = el('button', 'open');
      open.type = 'button';
      open.title = session.title;
      open.append(
        el('span', 'title', session.title),
        el('span', 'meta', when(session.mtimeMs) + ' · ' + session.source + ' · ' + size(session.size) + ' · ' + session.id.slice(0, 8))
      );
      open.addEventListener('click', () => openSession(session.id));
      const copy = el('button', 'copy', 'Copy path');
      copy.type = 'button';
      copy.title = session.file;
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(session.file);
          copy.textContent = 'Copied';
        } catch {
          prompt('Transcript path:', session.file);
        }
        setTimeout(() => { copy.textContent = 'Copy path'; }, 1500);
      });
      row.append(open, copy);
      group.append(row);
    }
    list.append(group);
  }
  applyFilter();
}

function applyFilter() {
  const words = $('filter').value.toLowerCase().split(/\\s+/).filter(Boolean);
  const source = $('source').value;
  let shown = 0;
  for (const group of document.querySelectorAll('.project')) {
    let visible = 0;
    for (const row of group.querySelectorAll('.session')) {
      const match = (!source || row.dataset.source === source) && words.every(word => row.dataset.search.includes(word));
      row.hidden = !match;
      if (match) visible += 1;
    }
    group.hidden = visible === 0;
    shown += visible;
  }
  const total = projects.reduce((sum, project) => sum + project.sessions.length, 0);
  status(shown === total ? total + ' sessions in ' + projects.length + ' projects' : shown + ' of ' + total + ' sessions');
}

async function load() {
  status('Loading sessions…');
  try {
    const response = await fetch('api/sessions', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    projects = (await response.json()).projects;
    render();
    if (selected) openSession(selected, true);
  } catch {
    status('The server is not reachable. It stops after an hour without use; run bsd-ims again.');
  }
}

$('filter').addEventListener('input', applyFilter);
$('source').addEventListener('change', applyFilter);
$('refresh').addEventListener('click', () => {
  load();
  if (!$('panel-log').hidden) loadAsks();
  if (!$('panel-settings').hidden) loadSettings();
});
$('stop').addEventListener('click', async () => {
  if (!confirm('Stop the bsd-ims server? Pages stop working until you run bsd-ims again.')) return;
  try { await fetch('stop', { method: 'POST' }); } catch {}
  document.body.textContent = '';
  document.body.append(el('p', 'empty', 'The bsd-ims server is stopped. Run bsd-ims to start it again.'));
});
load();
`;

export function renderMenuPage({ version = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BSD InspectMySession</title>
<style>${CSS}</style>
<script>${THEME_SCRIPT}</script>
</head>
<body>
<aside>
  <header>
    <div class="top">
      <h1>InspectMySession <span>${version ? `v${version}` : ''}</span></h1>
      <button id="theme" type="button" title="Switch both pages between dark and light">Light theme</button>
      <button id="refresh" type="button" title="Reload the session list and the ask log">Refresh</button>
      <button id="stop" type="button" title="Stop the local bsd-ims server">Stop server</button>
    </div>
  </header>
  <div class="tabs" role="tablist" aria-label="Menu">
    <button type="button" role="tab" id="tab-sessions" aria-controls="panel-sessions" aria-selected="true">Sessions</button>
    <button type="button" role="tab" id="tab-settings" aria-controls="panel-settings" aria-selected="false" tabindex="-1">Settings</button>
    <button type="button" role="tab" id="tab-log" aria-controls="panel-log" aria-selected="false" tabindex="-1">Ask log</button>
  </div>
  <section class="panel" id="panel-sessions" role="tabpanel" aria-labelledby="tab-sessions">
    <div class="filters">
      <input id="filter" type="search" placeholder="Filter by text, project, date or id" aria-label="Filter sessions">
      <select id="source" aria-label="Source">
        <option value="">All</option>
        <option value="vsc">vsc</option>
        <option value="cli">cli</option>
      </select>
    </div>
    <nav id="sessions" aria-label="Sessions"></nav>
    <div class="status" id="status"></div>
  </section>
  <section class="panel" id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
    <div class="field">
      <label for="set-askModel">Model for "Where did this come from?"</label>
      <select id="set-askModel">
        <option value="auto">Auto (recommended)</option>
        <option value="session">Same as the session</option>
        <option value="other" id="other-option">Other…</option>
      </select>
      <input id="set-askModel-other" placeholder="Model id, for example claude-sonnet-5-5" aria-label="Other model id" hidden>
      <p class="hint">Auto uses the session's own model while Anthropic's cache still holds the session, and Haiku 5.5
        once the cache has expired or the estimate is over the cost limit below.</p>
    </div>
    <div class="field">
      <label for="set-cacheLifetime">Cache lifetime</label>
      <select id="set-cacheLifetime">
        <option value="detect">Detect from the session (5 minutes if not recorded)</option>
        <option value="5m">5 minutes</option>
        <option value="1h">1 hour</option>
      </select>
    </div>
    <div class="field">
      <label for="set-costLimitUsd">Cost limit for using the session's model (US dollars)</label>
      <input id="set-costLimitUsd" type="number" min="0" max="100" step="0.01">
      <p class="hint">Auto uses Haiku 5.5 when the estimate with the session's model is higher. 0 means always Haiku.</p>
    </div>
    <div class="field">
      <label for="set-askTimeoutMinutes">Time limit per question (minutes)</label>
      <input id="set-askTimeoutMinutes" type="number" min="1" max="30" step="1">
    </div>
    <div class="field">
      <div class="row">
        <input id="set-keepQuestionText" type="checkbox">
        <label for="set-keepQuestionText">Keep the question and selected text in the ask log</label>
      </div>
      <p class="hint">The ask log is kept on this computer only.</p>
    </div>
    <div class="save-row"><button id="settings-save" type="button">Save</button><span id="settings-status" role="status"></span></div>
    <div class="field">
      <span class="label">Prices per million tokens</span>
      <table>
        <thead><tr><th>Model</th><th class="n">Input</th><th class="n">Cache read</th><th class="n">Output</th></tr></thead>
        <tbody id="prices-body"></tbody>
      </table>
      <p class="hint">Updated <span id="prices-date"></span>. Writing to the cache costs 1.25 times the input price
        (2 times for the 1-hour cache). Haiku 5.5 costs more for prompts over 100,000 tokens.</p>
    </div>
  </section>
  <section class="panel" id="panel-log" role="tabpanel" aria-labelledby="tab-log" hidden>
    <div class="filters">
      <input id="log-filter" type="search" placeholder="Filter by question, session, model or status" aria-label="Filter the ask log">
    </div>
    <div id="asks"></div>
    <div class="status" id="log-status"></div>
  </section>
</aside>
<main>
  <iframe id="frame" title="Session" hidden></iframe>
  <p class="empty" id="empty">Pick a session on the left.</p>
</main>
<dialog id="ask-detail" aria-label="Question details">
  <div id="ask-detail-body"></div>
  <div class="actions">
    <button type="button" id="ask-detail-open">Open the session</button>
    <button type="button" id="ask-detail-close">Close</button>
  </div>
</dialog>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
