const DATA = JSON.parse(document.getElementById('show-context-data').textContent);
const $ = id => document.getElementById(id);
const ICON = {
  mcp: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
    <path d="M6 1.8v3M10 1.8v3"/>
    <path d="M4 4.8h8v2.6a4 4 0 0 1-8 0z"/>
    <path d="M8 11.4v2.8"/>
  </svg>`,
  file: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
    <path d="M3.5 1.5h5.5l3.5 3.5v9.5h-9z"/>
    <path d="M9 1.5V5h3.5"/>
  </svg>`,
  explore: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
    <circle cx="6.8" cy="6.8" r="4.5"/>
    <path d="m10.2 10.2 3.7 3.7"/>
  </svg>`,
  skill: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
    <path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>
  </svg>`,
  web: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
    <circle cx="8" cy="8" r="6.5"/>
    <path d="M1.5 8h13M8 1.5c1.9 1.8 1.9 11.2 0 13M8 1.5c-1.9 1.8-1.9 11.2 0 13"/>
  </svg>`,
  run: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
    <path d="m3 4 4 4-4 4M8 12h5"/>
  </svg>`,
  start: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
    <rect x="2.5" y="2.5" width="11" height="11" rx="2"/>
  </svg>`
};
const LABEL = { file: 'File', explore: 'Explore', mcp: 'MCP', skill: 'Skill', web: 'Web' };
const fmt = value => (value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(value));
const esc = value =>
  String(value).replace(
    /[&<>"]/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]
  );
const clean = value =>
  String(value)
    .split('\n')
    .filter(line => !line.startsWith('── '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }
};
let frame = 0;

const ALL = new Map();
for (const part of DATA.startLoad.parts) {
  ALL.set(part.ref, { ...part, kind: 'start' });
  for (const item of part.items || []) ALL.set(item.ref, { ...item, kind: 'start' });
}
for (const read of DATA.reads) {
  ALL.set(read.ref, read);
  for (const file of read.files || []) ALL.set(file.ref, { ...file, kind: read.kind, rowRef: read.ref });
}

const themeButton = $('theme');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
  store.set('show-context-theme', theme);
  redraw();
}
setTheme(store.get('show-context-theme') === 'light' ? 'light' : 'dark');
// Inside the bsd-ims menu, the menu's theme button sets the theme for both pages.
if (window.top !== window) document.documentElement.classList.add('in-menu');
addEventListener('storage', event => {
  if (event.key === 'show-context-theme') setTheme(event.newValue === 'light' ? 'light' : 'dark');
});
themeButton.addEventListener('click', () =>
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
);
$('total').textContent = `${DATA.reads.length} reads · ${fmt(DATA.totalReadTokens)} tokens`;
$('legend').innerHTML = Object.keys(LABEL)
  .map(
    key => `<span><span style="color:var(--${key});display:inline-flex">${ICON[key]}</span>${LABEL[key]}</span>`
  )
  .join('');

function inlineMarkdown(value) {
  let text = esc(value);
  const codes = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}
function markdownTable(lines, index) {
  if (index + 1 >= lines.length || !lines[index].includes('|') || !/^\s*\|?\s*:?-{3,}/.test(lines[index + 1]))
    return null;
  const split = line =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map(cell => cell.trim());
  const head = split(lines[index]);
  let end = index + 2;
  const rows = [];
  while (end < lines.length && lines[end].includes('|') && lines[end].trim()) rows.push(split(lines[end++]));
  const header = head.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('');
  const body = rows.map(row => `<tr>${row.map(cell => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`);
  return { end, html: `<table><thead><tr>${header}</tr></thead><tbody>${body.join('')}</tbody></table>` };
}
function renderMarkdown(source) {
  const lines = String(source || '')
    .replaceAll('\r', '')
    .split('\n');
  let html = '';
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (/^```/.test(line)) {
      const language = line.slice(3).trim();
      const body = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) body.push(lines[index++]);
      if (index < lines.length) index += 1;
      html += `<pre><code${language ? ` data-language="${esc(language)}"` : ''}>${esc(body.join('\n'))}</code></pre>`;
      continue;
    }
    const table = markdownTable(lines, index);
    if (table) {
      html += table.html;
      index = table.end;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html += `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`;
      index += 1;
      continue;
    }
    const list = line.match(/^(\s{0,2})([-*+] |\d+\. )(.+)$/);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const tag = ordered ? 'ol' : 'ul';
      const baseIndent = list[1].length;
      let topOpen = false;
      let nestedTag = '';
      html += `<${tag}>`;
      while (index < lines.length) {
        const item = lines[index].match(/^(\s{0,4})([-*+] |\d+\. )(.+)$/);
        if (!item) break;
        const indent = item[1].length;
        if (indent <= baseIndent) {
          if (/\d/.test(item[2]) !== ordered) break;
          if (nestedTag) {
            html += `</${nestedTag}>`;
            nestedTag = '';
          }
          if (topOpen) html += '</li>';
          html += `<li>${inlineMarkdown(item[3])}`;
          topOpen = true;
        } else {
          if (!topOpen) break;
          const nextTag = /\d/.test(item[2]) ? 'ol' : 'ul';
          if (nestedTag && nestedTag !== nextTag) {
            html += `</${nestedTag}><${nextTag}>`;
            nestedTag = nextTag;
          } else if (!nestedTag) {
            html += `<${nextTag}>`;
            nestedTag = nextTag;
          }
          html += `<li>${inlineMarkdown(item[3])}</li>`;
        }
        index += 1;
      }
      if (nestedTag) html += `</${nestedTag}>`;
      if (topOpen) html += '</li>';
      html += `</${tag}>`;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,3})\s|^```|^(\s{0,2})([-*+] |\d+\. )/.test(lines[index])
    )
      paragraph.push(lines[index++]);
    html += `<p>${inlineMarkdown(paragraph.join('\n')).replaceAll('\n', '<br>')}</p>`;
  }
  return html;
}

const conv = $('conv');
conv.innerHTML =
  DATA.conversation
    .map(item => {
      if (item.type === 'compact') return '<div class="compact">Conversation compacted</div>';
      const tools = (item.tools || [])
        .map(tool => {
          const text = tool.isRead
            ? ALL.get(tool.ref)?.text || tool.result
            : `${JSON.stringify(tool.input, null, 2)}${tool.result ? `\n\nResult:\n${tool.result}` : ''}`;
          const size = tool.isRead ? `<span class="tk">${fmt(tool.size)}</span>` : '';
          const content = esc(text.slice(0, 4000)) + (text.length > 4000 ? '\n\n[truncated]' : '');
          return [
            `<details class="tool" data-tool-use-id="${esc(tool.id)}" data-ref="${esc(tool.ref)}"`,
            ` data-row-ref="${esc(tool.rowRef || tool.ref)}"`,
            ` style="--c:var(--${tool.kind})">`,
            `<summary>${ICON[tool.kind] || ICON.run}<span class="verb">${esc(tool.verb)}</span>`,
            `<span class="arg">${esc(tool.argument)}</span>${size}</summary>`,
            `<pre>${content}</pre></details>`
          ].join('');
        })
        .join('');
      return `<div class="msg ${item.role}" data-msg="${item.messageIndex}">
        <div class="who"><b>${item.role === 'user' ? 'You' : 'Claude'}</b></div>
        <div class="text">${renderMarkdown(item.text)}</div>
        ${tools ? `<div class="tools">${tools}</div>` : ''}
      </div>`;
    })
    .join('') + '<p class="hint">Select text in a Claude message or tool call to ask about its source.</p>';

const startRows = DATA.startLoad.parts.flatMap(part => [
  {
    kind: 'start-part',
    key: part.key,
    ref: part.ref,
    name: part.name,
    detail: part.detail,
    size: part.size,
    text: part.text
  },
  ...(part.items || []).map(item => ({
    kind: 'start-subpart',
    key: item.ref.slice(2),
    ref: item.ref,
    name: item.name,
    size: item.size,
    text: item.text
  }))
]);
const MAX = Math.max(1, ...DATA.reads.map(read => read.size), ...startRows.map(row => row.size));
const SCALE = 1000;
const KNOTS = [
  [0, 0],
  [150, Math.min(2000, MAX)],
  [350, Math.min(4000, MAX)],
  [SCALE, MAX]
];
const between = (value, key, other) => {
  for (let index = 1; index < KNOTS.length; index += 1) {
    const [a, b] = [KNOTS[index - 1], KNOTS[index]];
    if (value <= b[key] || index === KNOTS.length - 1) {
      const span = b[key] - a[key];
      return span <= 0 ? b[other] : a[other] + ((value - a[key]) / span) * (b[other] - a[other]);
    }
  }
  return 0;
};
const toTokens = position => Math.round(between(position, 0, 1));
const toPosition = tokens => Math.round(between(Math.max(0, tokens), 1, 0));
const slider = $('min');
const amount = $('amount');
slider.max = String(SCALE);
$('max-end').textContent = fmt(MAX);
const wanted = Number(new URLSearchParams(location.search).get('min') ?? store.get('show-context-min-v3') ?? 2000);
let min = Math.min(MAX, Math.max(0, Number.isFinite(wanted) ? wanted : 0));
const stack = $('stack');
const openKeys = new Set();
const viewerStates = new Map();
let forceRefs = new Set();
let answer = null;
function onActivate(element, action) {
  element.addEventListener('click', action);
  element.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  });
}
function addTextRow(segment, body, text, key) {
  const full = document.createElement('div');
  full.className = 'full-wrap';
  full.innerHTML = '<div class="pad"></div><pre class="full"></pre>';
  full.querySelector('.full').textContent = clean(text);
  if (openKeys.has(key)) {
    segment.classList.add('open');
    body.setAttribute('aria-expanded', 'true');
  }
  onActivate(body, () => {
    const open = segment.classList.toggle('open');
    body.setAttribute('aria-expanded', String(open));
    if (open) openKeys.add(key);
    else openKeys.delete(key);
    redraw();
  });
  stack.append(segment, full);
}
function lineLabel(start, end) {
  return start === end ? `L${start}` : `L${start}-${end}`;
}
function fileLines(file) {
  const values = String(file.text || '').split('\n');
  return values.map((text, index) => ({
    text,
    number: file.lineNumbers?.[index] ?? index + 1
  }));
}
function rowCitations(read) {
  return (answer?.data?.citations || []).filter(cite => cite.rowRef === read.ref && cite.quoteFound);
}
function fileFor(read, ref) {
  return read.files.find(file => file.ref === ref) || read.files[0];
}
function viewerLine(line, citations) {
  const cited = citations.some(cite => line.number >= cite.lineStart && line.number <= cite.lineEnd);
  return `<div class="viewer-line${cited ? ' viewer-cited' : ''}" data-line="${line.number}">
    <span class="line-no">${line.number}</span><span class="line-text">${esc(line.text) || ' '}</span>
  </div>`;
}
function isMarkdownFile(file) {
  return /\.(?:md|markdown)$/i.test(file.name || '');
}
function renderViewer(detail, row, read, key, fileRef, targetLine, requestedView) {
  const file = fileFor(read, fileRef);
  const citations = rowCitations(read);
  const fileCitations = citations.filter(cite => cite.fileRef === file.ref);
  const markdown = isMarkdownFile(file);
  const savedView = requestedView || viewerStates.get(key)?.view || 'rendered';
  const view = markdown && savedView !== 'source' ? 'rendered' : 'source';
  const tabs = read.files.length > 1
    ? `<div class="file-tabs" role="tablist">${read.files.map(item => {
      const badges = citations
        .filter(cite => cite.fileRef === item.ref)
        .map(cite => `<span class="tab-badge">${cite.n}</span>`)
        .join('');
      const selected = item.ref === file.ref;
      return `<button class="file-tab" type="button" role="tab" data-file-ref="${esc(item.ref)}"
        aria-selected="${selected}">${esc(item.name)}${badges}</button>`;
    }).join('')}</div>`
    : `<div class="viewer-name">${esc(file.name)}</div>`;
  const views = markdown ? `<div class="viewer-views" role="group" aria-label="File view">
    <button class="viewer-view" type="button" data-view="rendered"
      aria-pressed="${view === 'rendered'}">Rendered</button>
    <button class="viewer-view" type="button" data-view="source"
      aria-pressed="${view === 'source'}">Source</button>
  </div>` : '';
  const content = view === 'rendered'
    ? `<div class="viewer-scroll viewer-markdown text">${renderMarkdown(file.text)}</div>`
    : `<div class="viewer-scroll">${fileLines(file).map(line => viewerLine(line, fileCitations)).join('')}</div>`;
  detail.innerHTML = `<div class="viewer" data-file-ref="${esc(file.ref)}">
    <div class="viewer-head">${tabs}${views}
      <button class="viewer-close" type="button" aria-label="Close ${read.isStart ? 'full text' : 'full file'}">×</button>
    </div>
    ${content}
  </div>`;
  detail.querySelectorAll('.file-tab').forEach(tab => {
    tab.onclick = event => {
      event.stopPropagation();
      const nextRef = tab.dataset.fileRef;
      const state = { fileRef: nextRef, line: null, view: savedView };
      viewerStates.set(key, state);
      renderViewer(detail, row, read, key, nextRef, null, state.view);
    };
  });
  detail.querySelectorAll('.viewer-view').forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      const state = { fileRef: file.ref, line: targetLine, view: button.dataset.view };
      viewerStates.set(key, state);
      renderViewer(detail, row, read, key, file.ref, targetLine, state.view);
    };
  });
  detail.querySelector('.viewer-close').onclick = event => {
    event.stopPropagation();
    viewerStates.delete(key);
    if (row.classList.contains('cited')) {
      detail.replaceChildren();
      redraw();
      return;
    }
    row.classList.remove('open');
    row.querySelector('.body').setAttribute('aria-expanded', 'false');
    openKeys.delete(key);
    redraw();
  };
  requestAnimationFrame(() => {
    if (targetLine == null || view !== 'source') return;
    const target = detail.querySelector(`.viewer-line[data-line="${CSS.escape(String(targetLine))}"]`);
    const scroller = detail.querySelector('.viewer-scroll');
    if (target && scroller) {
      scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        - (scroller.clientHeight - target.offsetHeight) / 2;
    }
  });
}
function excerptLine(line) {
  return `<div class="excerpt-line" data-line="${line.number}">
    <span class="line-no">${line.number}</span><span class="line-text">${esc(line.text) || ' '}</span>
  </div>`;
}
function renderExcerpts(detail, row, read, key, citations) {
  detail.innerHTML = citations.map(cite => {
    const file = fileFor(read, cite.fileRef);
    const lines = fileLines(file);
    let start = lines.findIndex(line => line.number === cite.lineStart);
    let end = lines.findIndex(line => line.number === cite.lineEnd);
    if (start < 0) start = 0;
    if (end < start) end = start;
    const from = Math.max(0, start - 3);
    const to = Math.min(lines.length, end + 4);
    const before = lines.slice(from, start).map(excerptLine).join('');
    const marked = lines.slice(start, end + 1).map(excerptLine).join('');
    const after = lines.slice(end + 1, to).map(excerptLine).join('');
    return `<section class="excerpt" data-n="${cite.n}">
      <div class="excerpt-head">
        <button class="excerpt-select" type="button"><span class="num">${cite.n}</span>
          <span class="excerpt-title">${esc(file.name)} ${lineLabel(cite.lineStart, cite.lineEnd)}</span>
        </button>
        <button class="open-full" type="button" data-file-ref="${esc(file.ref)}"
          data-line="${cite.lineStart}">Open full ${read.isStart ? 'text' : 'file'}</button>
      </div>
      <div class="excerpt-lines">${before}<div class="excerpt-source src ${cite.kind}"
        data-n="${cite.n}">${marked}</div>${after}</div>
    </section>`;
  }).join('') + '<div class="excerpt-viewer"></div>';
  const viewer = detail.querySelector('.excerpt-viewer');
  for (const header of detail.querySelectorAll('.excerpt-head')) {
    header.onclick = () => activateCitation(Number(header.parentElement.dataset.n));
  }
  detail.querySelectorAll('.open-full').forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      activateCitation(Number(button.closest('.excerpt').dataset.n));
      const state = { fileRef: button.dataset.fileRef, line: Number(button.dataset.line), view: 'source' };
      viewerStates.set(key, state);
      renderViewer(viewer, row, read, key, state.fileRef, state.line, state.view);
      viewer.scrollIntoView({ block: 'nearest' });
    };
  });
  const state = viewerStates.get(key);
  if (state) renderViewer(viewer, row, read, key, state.fileRef, state.line, state.view);
}
function addReadRow(segment, body, read, key) {
  const wrap = document.createElement('div');
  wrap.className = 'full-wrap read-wrap';
  wrap.innerHTML = '<div class="pad"></div><div class="read-detail"></div>';
  const detail = wrap.querySelector('.read-detail');
  const citations = document.body.classList.contains('mode-split') ? rowCitations(read) : [];
  if (citations.length) {
    segment.classList.add('cited', 'open');
    body.setAttribute('aria-expanded', 'true');
    onActivate(body, () => activateCitation(citations[0].n, true));
    renderExcerpts(detail, segment, read, key, citations);
    stack.append(segment, wrap);
    return;
  }
  const showViewer = () => {
    const { fileRef, line, view } = viewerStates.get(key) || { fileRef: read.files[0].ref };
    renderViewer(detail, segment, read, key, fileRef, line, view);
  };
  if (openKeys.has(key)) {
    segment.classList.add('open');
    body.setAttribute('aria-expanded', 'true');
    showViewer();
  }
  onActivate(body, () => {
    const open = segment.classList.toggle('open');
    body.setAttribute('aria-expanded', String(open));
    if (open) {
      openKeys.add(key);
      showViewer();
    } else {
      openKeys.delete(key);
      viewerStates.delete(key);
    }
    redraw();
  });
  stack.append(segment, wrap);
}
function startRow(row) {
  const segment = document.createElement('div');
  segment.className = `seg ${row.kind}`;
  segment.dataset.startKey = row.key;
  segment.dataset.ref = row.ref;
  segment.style.setProperty('--c', 'var(--start)');
  segment.innerHTML = `<div class="axis"></div>
    <div class="body" tabindex="0" role="button" aria-expanded="false">
      <div class="line1">
        <span class="name">${esc(row.name)}</span>
        <span class="start-detail">${esc(row.detail || '')}</span>
        <span class="cite-slot"></span>
        <span class="size">${fmt(row.size)}</span>
      </div>
    </div>`;
  const body = segment.querySelector('.body');
  const key = row.ref;
  if (document.body.classList.contains('mode-split') && rowCitations(row).length) {
    addReadRow(segment, body, { ...row, isStart: true, files: [row] }, key);
  } else {
    addTextRow(segment, body, row.text, key);
  }
}
function readRow(read, running) {
  const explore = read.kind === 'explore';
  const height = explore ? 30 : Math.round(Math.min(110, Math.max(44, 44 + 14 * Math.log2(read.size / 500))));
  const segment = document.createElement('div');
  segment.className = explore ? 'seg explore' : 'seg';
  segment.dataset.ref = read.ref;
  segment.style.setProperty('--c', `var(--${read.kind})`);
  segment.innerHTML = `<div class="axis">${fmt(running)}</div>
    <div class="body" style="min-height:${height}px" tabindex="0" role="button" aria-expanded="false">
      <div class="line1">
        ${ICON[read.kind]}<span class="name">${esc(read.name)}</span>
        ${explore && read.location ? `<span class="explore-where">${esc(read.location)}</span>` : ''}
        <span class="cite-slot"></span>
        <span class="size">${fmt(read.size)}</span>
      </div>
      ${read.location && !explore ? `<div class="where">${esc(read.location)}</div>` : ''}
      ${read.items ? `<div class="items">${read.items.map(esc).join(' · ')}</div>` : ''}
    </div>`;
  addReadRow(segment, segment.querySelector('.body'), read, read.ref);
}
function visible(entry) {
  return entry.size >= min || forceRefs.has(entry.ref);
}
function renderContext() {
  slider.value = String(toPosition(min));
  slider.style.setProperty('--p', `${(toPosition(min) / SCALE) * 100}%`);
  if (document.activeElement !== amount) amount.value = String(min);
  store.set('show-context-min-v3', String(min));
  stack.textContent = '';
  stack.insertAdjacentHTML(
    'beforeend',
    `<div class="start-label"><b>Loaded at start</b><span class="size">${fmt(DATA.startLoadTokens)}</span></div>`
  );
  for (const row of startRows) if (visible(row)) startRow(row);
  stack.insertAdjacentHTML('beforeend', '<div class="start-end"></div>');
  let running = DATA.startLoadTokens;
  DATA.reads.forEach(read => {
    if (visible(read)) readRow(read, running);
    running += read.size;
  });
  stack.insertAdjacentHTML(
    'beforeend',
    `<div class="now">
      <div class="axis">${fmt(running)}</div>
      <div class="label"><b>Now</b> · ${fmt(running)} in context</div>
    </div>`
  );
}
slider.addEventListener('input', () => {
  min = toTokens(Number(slider.value));
  renderContext();
});
amount.addEventListener('input', () => {
  const value = Number(amount.value.replace(/[^\d]/g, ''));
  min = Math.min(MAX, Math.max(0, value || 0));
  renderContext();
});
renderContext();

function setMode(mode, remember = true) {
  const wasSplit = document.body.classList.contains('mode-split');
  document.body.classList.remove('mode-conv', 'mode-context', 'mode-split');
  document.body.classList.add(mode);
  if (answer?.data && wasSplit !== (mode === 'mode-split')) renderContext();
  $('m-conv').setAttribute('aria-pressed', String(mode !== 'mode-context'));
  $('m-context').setAttribute('aria-pressed', String(mode === 'mode-context'));
  if (remember && mode !== 'mode-split')
    store.set('show-context-mode', mode === 'mode-conv' ? 'conversation' : 'context');
  redraw();
}
$('m-conv').onclick = () => setMode(answer ? 'mode-split' : 'mode-conv');
$('m-context').onclick = () => setMode('mode-context');
setMode(store.get('show-context-mode') === 'conversation' ? 'mode-conv' : 'mode-context', false);

const ask = $('ask');
let pending = null;
function textNodes(container) {
  const nodes = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) nodes.push(node);
  return nodes;
}
function offsetOf(container, node, offset) {
  if (node.nodeType !== 3) {
    const probe = document.createRange();
    probe.setStart(container, 0);
    probe.setEnd(node, offset);
    return probe.toString().length;
  }
  let total = 0;
  for (const text of textNodes(container)) {
    if (text === node) return total + offset;
    total += text.length;
  }
  return total;
}

function selectedText({ container, start, end }) {
  const blockSelector = 'p, li, h1, h2, h3, h4, h5, h6, pre, td, th, tr';
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      return node.nodeType === Node.TEXT_NODE || node.nodeName === 'BR'
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    }
  });
  let position = 0;
  let previousBlock;
  let text = '';

  // Add separators only to the submitted text. The offsets still count DOM text characters.
  for (let node; position < end && (node = walker.nextNode());) {
    if (node.nodeName === 'BR') {
      if (position > start) text += '\n';
      continue;
    }
    const nodeStart = position;
    position += node.length;
    const from = Math.max(start, nodeStart);
    const to = Math.min(end, position);
    if (from >= to) continue;

    const block = node.parentElement.closest(blockSelector);
    if (text && block !== previousBlock) text += '\n';
    text += node.data.slice(from - nodeStart, to - nodeStart);
    previousBlock = block;
  }
  return text.trim().replace(/\s+/g, ' ');
}

function wrapOffsets(container, start, end) {
  const marks = [];
  let position = 0;
  for (const node of textNodes(container)) {
    const length = node.length;
    const from = Math.max(start, position);
    const to = Math.min(end, position + length);
    if (to > from && node.textContent.slice(from - position, to - position).trim()) {
      const range = document.createRange();
      range.setStart(node, from - position);
      range.setEnd(node, to - position);
      const mark = document.createElement('mark');
      mark.className = 'q';
      range.surroundContents(mark);
      marks.push(mark);
    }
    position += length;
  }
  return marks;
}
function readSelection() {
  const selection = getSelection();
  if (!selection.rangeCount || !selection.toString().trim()) return null;
  const range = selection.getRangeAt(0);
  const el = node => (node.nodeType === 1 ? node : node.parentElement);
  const tool = el(range.startContainer)?.closest('#conv .tool') || el(range.endContainer)?.closest('#conv .tool');
  if (tool) return { kind: 'tool', tool, rect: tool.querySelector('summary').getBoundingClientRect() };
  const container =
    el(range.startContainer)?.closest('.msg.assistant .text') ||
    el(range.endContainer)?.closest('.msg.assistant .text');
  if (!container) return null;
  const start = container.contains(range.startContainer)
    ? offsetOf(container, range.startContainer, range.startOffset)
    : 0;
  const end = container.contains(range.endContainer)
    ? offsetOf(container, range.endContainer, range.endOffset)
    : container.textContent.length;
  if (container.textContent.slice(start, end).trim().length < 2) return null;
  return { kind: 'text', container, start, end, rect: range.getBoundingClientRect(), range: range.cloneRange() };
}
function placeMenu() {
  const rect = pending?.rect;
  if (!rect) return;
  const width = ask.offsetWidth;
  ask.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, rect.left + rect.width / 2 - width / 2))}px`;
  const above = rect.top - ask.offsetHeight - 10;
  ask.style.top = `${above > 60 ? above : rect.bottom + 10}px`;
}
function showMenu() {
  const found = readSelection();
  if (!found) {
    ask.classList.remove('on');
    pending = null;
    return;
  }
  pending = found;
  $('ask-label').textContent = found.kind === 'tool' ? 'Why was this called?' : 'Where did this come from?';
  ask.classList.remove('typing');
  ask.classList.add('on');
  placeMenu();
}
document.addEventListener('mouseup', event => {
  if (!ask.contains(event.target)) setTimeout(showMenu);
});
document.addEventListener('keyup', event => {
  if (event.shiftKey && !ask.contains(event.target)) showMenu();
});
document.addEventListener('mousedown', event => {
  if (!ask.contains(event.target)) {
    ask.classList.remove('on');
    window.CSS?.highlights?.delete('pending');
  }
});
$('conv-pane').addEventListener('scroll', () => ask.classList.remove('on'));
conv.addEventListener('click', event => {
  if (event.target.closest('.tool summary') && getSelection().toString().trim()) event.preventDefault();
});
$('ask-chat').onclick = () => {
  let keep = pending?.range;
  if (pending?.tool) {
    keep = document.createRange();
    keep.selectNodeContents(pending.tool.querySelector('summary'));
  }
  if (keep && window.CSS?.highlights) CSS.highlights.set('pending', new Highlight(keep));
  ask.classList.add('typing');
  placeMenu();
  $('ask-input').focus();
};
function sendOwn() {
  const value = $('ask-input').value.trim();
  if (value) go(value);
}
$('ask-send').onclick = sendOwn;
$('ask-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') sendOwn();
  if (event.key === 'Escape') {
    ask.classList.remove('typing');
    $('ask-input').value = '';
    placeMenu();
  }
});

function clearAnswer() {
  for (const cite of answer?.data?.citations || []) viewerStates.delete(cite.rowRef);
  if (answer?.tool) answer.mark.classList.remove('asked');
  else for (const mark of answer?.marks || []) mark.replaceWith(...mark.childNodes);
  conv.querySelectorAll('.text').forEach(text => text.normalize());
  answer = null;
  forceRefs = new Set();
  renderContext();
  conv.querySelectorAll('.tool.cited').forEach(tool => tool.classList.remove('cited'));
  document.body.classList.remove('answered');
  $('answer').classList.remove('on');
  $('wires').innerHTML = '';
}
function closeAnswer() {
  clearAnswer();
  setMode('mode-conv');
}
function cardHeading(question, count = 0) {
  const stepper = count ? `<div class="source-stepper">
    <button type="button" data-step="-1" aria-label="Previous source">‹</button>
    <span class="source-position" aria-live="polite"></span>
    <button type="button" data-step="1" aria-label="Next source">›</button>
  </div>` : '';
  return `<div class="a-top">
    <div class="a-q">${esc(question)}</div>
    ${stepper}
    <button class="a-close" aria-label="Close">×</button>
  </div>`;
}
function waitingCard(question, label) {
  const card = $('answer');
  card.innerHTML = `${cardHeading(question)}
    <div class="a-sel">${esc(label)}</div>
    <div class="a-wait"><i></i>Asking a fork of this session...</div>`;
  card.querySelector('.a-close').onclick = closeAnswer;
  card.classList.add('on');
  setMode('mode-split', false);
}
async function runAsk(body, label, question) {
  if (!DATA.live) {
    $('answer').innerHTML = `${cardHeading(question)}
      <p>Asking needs the live page. Run bsd-ims without --static.</p>`;
    $('answer').querySelector('.a-close').onclick = closeAnswer;
    return;
  }
  try {
    const response = await fetch('ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Ask failed with status ${response.status}.`);
    showAnswer(data, label, question);
  } catch (error) {
    $('answer').innerHTML = `${cardHeading(question)}
      <p class="a-error">${esc(error.message || error)}</p>`;
    $('answer').querySelector('.a-close').onclick = closeAnswer;
  }
}
function submit(found, question) {
  const text = selectedText(found);
  clearAnswer();
  const marks = wrapOffsets(found.container, found.start, found.end);
  answer = { mark: marks.at(-1), marks, tool: false };
  waitingCard(question, `“${text}”`);
  runAsk(
    { kind: 'text', question, text, messageIndex: Number(found.container.closest('.msg').dataset.msg) },
    text,
    question
  );
}
function askTool(tool, question) {
  clearAnswer();
  tool.open = false;
  tool.classList.add('asked');
  answer = { mark: tool, tool: true };
  const ref = tool.dataset.rowRef || tool.dataset.ref;
  if (ref) forceRefs.add(ref);
  renderContext();
  const row = ref ? stack.querySelector(`.seg[data-ref="${CSS.escape(ref)}"]`) : null;
  if (row) {
    row.classList.add('asked-row');
    row
      .querySelector('.cite-slot')
      .insertAdjacentHTML('beforebegin', '<span class="asked-tag">You asked about this call</span>');
  }
  const label = `${tool.querySelector('.verb').textContent} ${tool.querySelector('.arg').textContent}`;
  waitingCard(question, label);
  runAsk({ kind: 'tool', question, toolUseId: tool.dataset.toolUseId }, label, question);
}
function go(question) {
  if (!pending) return;
  const found = pending;
  pending = null;
  ask.classList.remove('on');
  window.CSS?.highlights?.delete('pending');
  $('ask-input').value = '';
  getSelection().removeAllRanges();
  if (found.kind === 'tool') askTool(found.tool, question || 'Why was this called?');
  else submit(found, question || 'Where did this come from?');
}
$('ask-why').onclick = () => go();

function activateCitation(n, center = false) {
  const citations = answer?.data?.citations;
  if (!citations?.[n - 1]) return;
  answer.active = n;
  const card = $('answer');
  card.querySelector('.source-position').textContent = `${n} of ${citations.length}`;
  for (const item of card.querySelectorAll('.cite')) {
    if (Number(item.dataset.n) === n) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  }
  const source = stack.querySelector(`.excerpt-source[data-n="${n}"]`);
  if (center && source?.getClientRects().length) {
    const pane = $('reads-pane');
    const rect = source.getBoundingClientRect();
    const top = pane.scrollTop + rect.top + (rect.height - pane.clientHeight) / 2 - pane.getBoundingClientRect().top;
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    pane.scrollTo({ top, behavior });
  }
  redraw();
}
function stepCitation(delta) {
  const count = answer?.data?.citations.length;
  if (count) activateCitation((answer.active - 1 + delta + count) % count + 1, true);
}
function showAnswer(data, label, question) {
  answer.data = data;
  data.citations.forEach((cite, index) => {
    cite.n = index + 1;
  });
  forceRefs = new Set([...forceRefs, ...data.citations.filter(cite => cite.quoteFound).map(cite => cite.rowRef)]);
  renderContext();
  for (const tool of conv.querySelectorAll('.tool[data-ref]')) {
    if (data.citations.some(cite => cite.quoteFound && [cite.fileRef, cite.rowRef].includes(tool.dataset.ref))) {
      tool.classList.add('cited');
    }
  }
  document.body.classList.add('answered');
  const card = $('answer');
  const citations = data.citations
    .map(cite => {
      const item = ALL.get(cite.fileRef || cite.ref);
      const kind = cite.kind === 'copied' ? 'Taken from this read' : 'Inferred from this read';
      const line = cite.quoteFound ? `<span class="c-line">${esc(item.name)} ` +
        `${lineLabel(cite.lineStart, cite.lineEnd)}</span>` : '';
      return `<li class="cite ${cite.kind}" data-n="${cite.n}" tabindex="0" style="--c:var(--${item.kind})">
        <span class="num">${cite.n}</span>
        <div>
          <div class="c-head">
            ${ICON[item.kind] || ICON.start}${line || esc(item.name)}<span class="c-kind">${kind}</span>
          </div>
          <div class="c-exp">${esc(cite.explanation)}</div>
          ${cite.quoteFound ? '' : '<div class="quote-missing">Quote not found</div>'}
        </div>
      </li>`;
    })
    .join('');
  const sessionId = esc(DATA.sessionId.slice(0, 8));
  const seconds = (data.durationMs / 1000).toFixed(1);
  const cost = Number(data.costUsd).toFixed(4);
  const footer = `Answered by a fork of session ${sessionId} in ${seconds} s, $${cost}. ` +
    'The original session does not change.';
  card.innerHTML = `${cardHeading(question, data.citations.length)}
    <div class="a-sel">${esc(label)}</div>
    <p class="a-sum">${esc(data.summary)}</p>
    <ol class="cites">${citations}</ol>
    <div class="a-foot"><span>${footer}</span></div>`;
  card.querySelector('.a-close').onclick = closeAnswer;
  for (const button of card.querySelectorAll('[data-step]')) button.onclick = () => stepCitation(Number(button.dataset.step));
  for (const item of card.querySelectorAll('.cite')) onActivate(item, () => activateCitation(Number(item.dataset.n), true));
  activateCitation(1);
  requestAnimationFrame(() => {
    if (answer?.data !== data || answer.active !== 1) return;
    const first = stack.querySelector('.excerpt[data-n="1"]');
    // Keep the selection above the answer card, then align the first excerpt with it.
    const conv = $('conv-pane');
    const before = answer.mark.getClientRects()[0];
    if (before) {
      const paneTop = conv.getBoundingClientRect().top;
      const cardTop = card.getBoundingClientRect().top;
      const target = Math.max(paneTop + 24, Math.min(paneTop + conv.clientHeight * 0.25, cardTop - 80));
      conv.scrollTop += before.top - target;
    }
    const selected = answer.mark.getClientRects()[0];
    if (first?.getClientRects().length && selected) {
      const pane = $('reads-pane');
      const source = first.querySelector('.excerpt-source').getBoundingClientRect();
      const top = first.getBoundingClientRect().top;
      const paneRect = pane.getBoundingClientRect();
      const delta = Math.max(top - selected.top, source.top + source.height / 2 - paneRect.bottom + 24);
      pane.scrollTop += delta;
    }
    redraw();
  });
}

const wires = $('wires');
function placeBadges(sources, pane) {
  const top = pane.top + 12;
  const bottom = pane.bottom - 12;
  const gap = 24;
  let next = top;
  for (const source of sources) {
    source.y = Math.max(next, Math.min(bottom, source.center));
    next = source.y + gap;
  }
  next = bottom;
  for (const source of sources.toReversed()) {
    source.y = Math.min(next, source.y);
    next = source.y - gap;
  }
}
function draw() {
  const focused = wires.contains(document.activeElement) ? document.activeElement.dataset.n : '';
  if (!answer?.data || !document.body.classList.contains('mode-split')) {
    wires.replaceChildren();
    return;
  }
  const color = getComputedStyle(document.documentElement).getPropertyValue('--now').trim();
  const card = getComputedStyle(document.documentElement).getPropertyValue('--card').trim();
  const convRect = $('conv-pane').getBoundingClientRect();
  const readsRect = $('reads-pane').getBoundingClientRect();
  const rects = answer.mark.getClientRects();
  const last = rects[rects.length - 1];
  const sources = [];
  for (const src of stack.querySelectorAll('.excerpt-source')) {
    const rect = src.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const pin = rect.bottom <= readsRect.top ? 'up' : rect.top >= readsRect.bottom ? 'down' : '';
    const center = (Math.max(rect.top, readsRect.top) + Math.min(rect.bottom, readsRect.bottom)) / 2;
    sources.push({ src, rect, pin, center });
  }
  placeBadges(sources, readsRect);
  let svg = '';
  for (const { src, rect, pin, center, y } of sources) {
    const n = Number(src.dataset.n);
    const inferred = src.classList.contains('inferred');
    const active = n === answer.active;
    const opacity = active ? 1 : 0.45;
    const x = Math.max(readsRect.left + 11, rect.left - 16);
    const dash = inferred ? 'stroke-dasharray="5 4"' : '';
    if (last && !pin) {
      const fromX = last.right + 3;
      const fromY = Math.max(convRect.top + 6, Math.min(convRect.bottom - 6, last.top + last.height / 2));
      const endX = x - 10;
      const bend = Math.min(Math.max(fromX, convRect.right - 18), endX);
      const mid = (bend + endX) / 2;
      const path = `M${fromX},${fromY} L${bend},${fromY} C${mid},${fromY} ${mid},${y} ${endX},${y}`;
      svg += `<g opacity="${opacity}">
        <path d="${path}" fill="none" stroke="${color}" stroke-width="${active ? 2.4 : 1.6}" ${dash}/>
        <line x1="${x + 10}" y1="${y}" x2="${rect.left}" y2="${center}" stroke="${color}" ${dash}/>
      </g>`;
    }
    const fill = inferred ? color : '#fff';
    const arrow = pin ? `<text x="${x + 16}" y="${y + 4}" fill="${color}">${pin === 'up' ? '↑' : '↓'}</text>` : '';
    svg += `<g class="wire-badge" data-n="${n}" data-pin="${pin}" role="button" tabindex="0"
      aria-label="Go to source ${n}" opacity="${pin ? 0.5 : opacity}">
      <circle cx="${x}" cy="${y}" r="10" fill="${inferred ? card : color}" stroke="${color}"/>
      <text x="${x}" y="${y + 3.8}" text-anchor="middle" font-size="11" font-weight="600" fill="${fill}">${n}</text>
      ${arrow}
    </g>`;
  }
  wires.innerHTML = svg;
  if (focused) wires.querySelector(`.wire-badge[data-n="${focused}"]`)?.focus({ preventScroll: true });
}
function activateBadge(event) {
  const badge = event.target.closest('.wire-badge');
  if (badge) activateCitation(Number(badge.dataset.n), true);
}
wires.addEventListener('click', activateBadge);
wires.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  activateBadge(event);
});
function redraw() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(draw);
}
$('conv-pane').addEventListener('scroll', redraw);
$('reads-pane').addEventListener('scroll', redraw);
addEventListener('resize', redraw);
document.addEventListener('keydown', event => {
  const inField = event.target.closest?.('input, textarea, select, [contenteditable]');
  if (!event.defaultPrevented && !inField && answer?.data?.citations.length) {
    const previous = event.key === '[' || (event.altKey && event.key === 'ArrowUp');
    const next = event.key === ']' || (event.altKey && event.key === 'ArrowDown');
    if (previous || next) {
      event.preventDefault();
      stepCitation(previous ? -1 : 1);
    }
  }
  if (event.key !== 'Escape') return;
  const close = stack.querySelector('.seg.open + .full-wrap .viewer-close');
  if (close) close.click();
});
