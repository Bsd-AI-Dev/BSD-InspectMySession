// The menu around the session pages: sessions grouped by project on the left, the chosen page on the right.
// The session page itself is the unchanged show-context page, loaded in a frame from s/<id>/.

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
.top { display: flex; align-items: center; gap: 6px; }
.top h1 { font-size: 14px; margin: 0; flex: 1; font-weight: 600; }
.top h1 span { color: var(--muted); font-weight: 400; font-size: 12px; }
button {
  font: inherit; color: var(--text); background: var(--button); border: 1px solid var(--line);
  border-radius: 6px; padding: 3px 8px; cursor: pointer;
}
button:hover { background: var(--hover); }
#stop { color: var(--danger); }
.filters { display: flex; gap: 6px; }
#filter, #source {
  font: inherit; color: var(--text); background: var(--button); border: 1px solid var(--line);
  border-radius: 6px; padding: 5px 8px;
}
#filter { flex: 1; min-width: 0; }
#sessions { flex: 1; overflow-y: auto; padding: 4px 0 12px; }
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
#status { padding: 8px 12px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); }
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
$('refresh').addEventListener('click', load);
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
      <button id="refresh" type="button" title="Reload the session list">Refresh</button>
      <button id="stop" type="button" title="Stop the local bsd-ims server">Stop server</button>
    </div>
    <div class="filters">
      <input id="filter" type="search" placeholder="Filter by text, project, date or id" aria-label="Filter sessions">
      <select id="source" aria-label="Source">
        <option value="">All</option>
        <option value="vsc">vsc</option>
        <option value="cli">cli</option>
      </select>
    </div>
  </header>
  <nav id="sessions" aria-label="Sessions"></nav>
  <div id="status"></div>
</aside>
<main>
  <iframe id="frame" title="Session" hidden></iframe>
  <p class="empty" id="empty">Pick a session on the left.</p>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
