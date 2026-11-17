const DATA = JSON.parse(document.getElementById('show-context-data').textContent);
const ICON = {
  mcp: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1.8v3M10 1.8v3"/><path d="M4 4.8h8v2.6a4 4 0 0 1-8 0z"/><path d="M8 11.4v2.8"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M3.5 1.5h5.5l3.5 3.5v9.5h-9z"/><path d="M9 1.5V5h3.5"/></svg>',
  explore: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="6.8" cy="6.8" r="4.5"/><path d="m10.2 10.2 3.7 3.7"/></svg>',
  skill: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>',
  web: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c1.9 1.8 1.9 11.2 0 13M8 1.5c-1.9 1.8-1.9 11.2 0 13"/></svg>'
};
const LABEL = { file: 'File', explore: 'Explore', mcp: 'MCP', skill: 'Skill', web: 'Web' };
const fmt = value => value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(value);
const esc = value => String(value).replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
const clean = value => String(value).split('\n').filter(line => !line.startsWith('── ')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} }
};

// Theme: light by default.
const themeButton = document.getElementById('theme');
const setTheme = theme => {
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
  store.set('show-context-theme', theme);
};
setTheme(store.get('show-context-theme') === 'dark' ? 'dark' : 'light');
themeButton.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

document.getElementById('total').textContent = `${DATA.reads.length} reads · ${fmt(DATA.totalReadTokens)} tokens`;
document.getElementById('legend').innerHTML = Object.keys(LABEL)
  .map(key => `<span><span style="color:var(--${key});display:inline-flex">${ICON[key]}</span>${LABEL[key]}</span>`).join('');

// Start rows as one flat list: parts and their files.
const startRows = DATA.startLoad.parts.flatMap(part => [
  { kind: 'start-part', key: part.key, name: part.name, detail: part.detail, size: part.size, text: part.text },
  ...(part.items || []).map((item, index) => ({ kind: 'start-subpart', key: `${part.key}-${index}`, name: item.name, size: item.size, text: item.text }))
]);

// Continuous filter: 0 to the largest row, on a log scale so small values get fine steps.
const MAX = Math.max(1, ...DATA.reads.map(read => read.size), ...startRows.map(row => row.size));
const SCALE = 1000;
// Piecewise scale: 0 to 2k moves fast, 2k to 4k a bit slower, 4k to the top gets most of the travel.
const KNOTS = [[0, 0], [150, Math.min(2000, MAX)], [350, Math.min(4000, MAX)], [SCALE, MAX]];
const between = (value, from, to, key, other) => {
  for (let i = 1; i < KNOTS.length; i += 1) {
    const [a, b] = [KNOTS[i - 1], KNOTS[i]];
    if (value <= b[key] || i === KNOTS.length - 1) {
      const span = b[key] - a[key];
      return span <= 0 ? b[other] : a[other] + (value - a[key]) / span * (b[other] - a[other]);
    }
  }
  return 0;
};
const toTokens = position => Math.round(between(position, 0, 0, 0, 1));
const toPosition = tokens => Math.round(between(Math.max(0, tokens), 0, 0, 1, 0));
const slider = document.getElementById('min');
const amount = document.getElementById('amount');
slider.max = String(SCALE);
document.getElementById('max-end').textContent = fmt(MAX);
const wanted = Number(new URLSearchParams(location.search).get('min') ?? store.get('show-context-min-v3') ?? 2000);
let min = Math.min(MAX, Math.max(0, Number.isFinite(wanted) ? wanted : 0));

const stack = document.getElementById('stack');
const openKeys = new Set();

function onActivate(element, action) {
  element.addEventListener('click', action);
  element.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); }
  });
}

function addRow(segment, body, text, key) {
  const full = document.createElement('div');
  full.className = 'full-wrap';
  full.innerHTML = '<div class="pad"></div><pre class="full"></pre>';
  full.querySelector('.full').textContent = clean(text);
  if (openKeys.has(key)) { segment.classList.add('open'); body.setAttribute('aria-expanded', 'true'); }
  onActivate(body, () => {
    const open = segment.classList.toggle('open');
    body.setAttribute('aria-expanded', String(open));
    if (open) openKeys.add(key); else openKeys.delete(key);
  });
  stack.appendChild(segment);
  stack.appendChild(full);
}

function startRow(row) {
  const segment = document.createElement('div');
  segment.className = `seg ${row.kind}`;
  segment.dataset.startKey = row.key;
  segment.style.setProperty('--c', 'var(--start)');
  segment.innerHTML = `
    <div class="axis"></div>
    <div class="body" tabindex="0" role="button" aria-expanded="false" aria-label="${esc(row.name)}, ${fmt(row.size)} tokens, show the text">
      <div class="line1"><span class="name">${esc(row.name)}</span><span class="start-detail">${esc(row.detail || '')}</span><span class="size">${fmt(row.size)}</span></div>
    </div>`;
  addRow(segment, segment.querySelector('.body'), row.text, `start-${row.key}`);
}

function readRow(read, index, running) {
  const explore = read.kind === 'explore';
  // Height grows with size, but slowly, so one big read does not fill the screen.
  const height = explore ? 30 : Math.round(Math.min(110, Math.max(44, 44 + 14 * Math.log2(read.size / 500))));
  const segment = document.createElement('div');
  segment.className = explore ? 'seg explore' : 'seg';
  segment.style.setProperty('--c', `var(--${read.kind})`);
  segment.innerHTML = `
    <div class="axis">${fmt(running)}</div>
    <div class="body" style="min-height:${height}px" tabindex="0" role="button" aria-expanded="false" aria-label="${esc(read.name)}, ${fmt(read.size)} tokens, show the text">
      <div class="line1">${ICON[read.kind]}<span class="name">${esc(read.name)}</span>${explore && read.location ? `<span class="explore-where">${esc(read.location)}</span>` : ''}<span class="size">${fmt(read.size)}</span></div>
      ${read.location && !explore ? `<div class="where">${esc(read.location)}</div>` : ''}
      ${read.items ? `<div class="items">${read.items.map(esc).join('  ·  ')}</div>` : ''}
    </div>`;
  const body = segment.querySelector(".body");
  addRow(segment, body, read.text, `read-${index}`);
}

// Walk a list and draw only the rows at or above the filter.
function walk(entries, draw) {
  let shown = 0;
  for (const entry of entries) {
    if (entry.size < min) continue;
    draw(entry);
    shown += 1;
  }
  return shown;
}

function render() {
  slider.value = String(toPosition(min));
  slider.style.setProperty('--p', `${toPosition(min) / SCALE * 100}%`);
  if (document.activeElement !== amount) amount.value = String(min);
  store.set('show-context-min-v3', String(min));
  stack.textContent = '';

  stack.insertAdjacentHTML('beforeend', `<div class="start-label"><b>Loaded at start</b><span class="size">${fmt(DATA.startLoadTokens)}</span></div>`);
  const startShown = walk(startRows.map((row, index) => ({ ...row, index, color: 'start' })), startRow);
  stack.insertAdjacentHTML('beforeend', '<div class="start-end"></div>');

  let running = DATA.startLoadTokens;
  const entries = DATA.reads.map((read, index) => {
    const entry = { read, index, running, size: read.size, color: read.kind };
    running += read.size;
    return entry;
  });
  const readsShown = walk(entries, entry => readRow(entry.read, entry.index, entry.running));

  stack.insertAdjacentHTML('beforeend', `
    <div class="now"><div class="axis">${fmt(running)}</div><div class="label"><b>Now</b> · ${fmt(running)} in context</div></div>`);
}

slider.addEventListener('input', () => { min = toTokens(Number(slider.value)); render(); });
amount.addEventListener('input', () => {
  const value = Number(amount.value.replace(/[^\d]/g, ''));
  min = Math.min(MAX, Math.max(0, value || 0));
 
  render();
});
render();
