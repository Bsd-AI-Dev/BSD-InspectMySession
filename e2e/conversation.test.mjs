import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { validateAskAnswer } from '../src/ask-answer.mjs';
import { buildAskPrompt } from '../src/ask-prompt.mjs';
import { parseTranscript } from '../src/show-context.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const cli = path.join(repo, 'bin/show-context.mjs');
const fixture = path.join(import.meta.dirname, 'fixtures/conversation.jsonl');
const demoFixture = path.join(import.meta.dirname, 'fixtures/demo.jsonl');
const demoAnswer = path.join(import.meta.dirname, 'fixtures/demo-answer.json');
const fake = path.join(import.meta.dirname, 'fixtures/fake-claude.mjs');
const sessionId = 'eeeeeeee-5555-4555-8555-555555555555';
const demoSessionId = 'dddddddd-4444-4444-8444-444444444444';
let temp;
let projects;
let sessionFile;
let splitDir;
let splitModel;
let editedSplitModel;
const servers = [];
let chrome = '';

const splitFiles = {
  'a.md': '# Alpha\n\n- First item\n\n| Name | Value |\n| --- | --- |\n| A | 1 |\n',
  'b.md': '## Beta\n\nBeta cited line\nBeta closing\n',
  'c.txt': 'Plain text\nMiddle text\nClosing text\n'
};

const jsonLine = value => `${JSON.stringify(value)}\n`;

function start(args = [], env = {}, selectedSessionId = sessionId) {
  const child = spawn(process.execPath, [cli, selectedSessionId, '--no-open', ...args], {
    cwd: repo,
    env: {
      ...process.env,
      SHOW_CONTEXT_PROJECTS: projects,
      SHOW_CONTEXT_OUT: path.join(temp, `page-${Math.random()}.html`),
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitForUrl(run, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = run.stdout().match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\//);
    if (match) return match[0];
    if (run.child.exitCode != null) throw new Error(`CLI exited before URL: ${run.stdout()} ${run.stderr()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`URL timeout: ${run.stdout()} ${run.stderr()}`);
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return '';
}

async function openCdp(url) {
  const profile = path.join(temp, `cdp-${Math.random().toString(16).slice(2)}`);
  await mkdir(profile, { recursive: true });
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--disable-gpu',
      '--no-first-run',
      '--no-sandbox',
      `--user-data-dir=${profile}`,
      url
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  const browserWs = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Chrome CDP timeout: ${stderr}`)), 5000);
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once('exit', code => reject(new Error(`Chrome exited with ${code}: ${stderr}`)));
  });
  const endpoint = new URL(browserWs);
  let page;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const list = await fetch(`http://${endpoint.host}/json`).then(response => response.json());
    page = list.find(target => target.type === 'page' && target.url.startsWith(url));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!page) throw new Error('Chrome page target was not found.');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  const requests = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  return { child, socket, send, evaluate, exceptions, requests };
}

async function waitForValue(cdp, expression, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await cdp.evaluate(expression);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Browser condition timed out: ${expression}`);
}

before(async () => {
  chrome = await findChrome();
  temp = await mkdtemp(path.join(os.tmpdir(), 'show-context-conversation-'));
  projects = path.join(temp, 'projects');
  const project = path.join(projects, 'fixture');
  await mkdir(project, { recursive: true });
  sessionFile = path.join(project, `${sessionId}.jsonl`);
  await copyFile(fixture, sessionFile);
  const demoProject = path.join(temp, 'todo-api');
  await mkdir(demoProject, { recursive: true });
  const demoRecords = (await readFile(demoFixture, 'utf8')).trim().split('\n').map(JSON.parse);
  const environment = demoRecords.find(record => record.attachment?.type === 'environment').attachment;
  environment.content = `Working directory: ${demoProject}\nPlatform: local development`;
  environment.snapshot.workingDirectory = demoProject;
  await writeFile(path.join(project, `${demoSessionId}.jsonl`), `${demoRecords.map(jsonLine).join('')}`);
  splitDir = path.join(temp, 'split-files');
  await mkdir(splitDir, { recursive: true });
  for (const [name, text] of Object.entries(splitFiles)) await writeFile(path.join(splitDir, name), text);
  const changedDir = path.join(temp, 'changed-file');
  const changedPath = path.join(changedDir, 'changed.md');
  await mkdir(changedDir, { recursive: true });
  await writeFile(changedPath, 'Current disk text\n');
  const listing = 'a.md\nb.md\nc.txt\n';
  const records = [
    {
      type: 'assistant',
      isSidechain: false,
      message: {
        id: 'conversation-a3',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'conversation-split',
            name: 'Bash',
            input: { command: `cd ${splitDir} && cat a.md b.md c.txt && ls`, description: 'Read three files and list folder' }
          },
          {
            type: 'tool_use',
            id: 'conversation-changed',
            name: 'Bash',
            input: { command: `cat ${changedPath}`, description: 'Read changed file' }
          }
        ],
        usage: { input_tokens: 500 }
      }
    },
    {
      type: 'user',
      isSidechain: false,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'conversation-split',
            content: `${Object.values(splitFiles).join('')}${listing}`
          },
          { type: 'tool_result', tool_use_id: 'conversation-changed', content: 'Old transcript text\n' }
        ]
      }
    },
    {
      type: 'assistant',
      isSidechain: false,
      message: {
        id: 'conversation-a4',
        role: 'assistant',
        content: [{ type: 'text', text: 'Read the files.' }],
        usage: { input_tokens: 700 }
      }
    }
  ];
  await writeFile(sessionFile, `${await readFile(sessionFile, 'utf8')}${records.map(jsonLine).join('')}`);
  splitModel = parseTranscript(await readFile(sessionFile, 'utf8'), { home: os.homedir(), sessionId });
  await writeFile(path.join(splitDir, 'b.md'), '## Beta\n\nNew middle line\nBeta cited line\nNew closing\n');
  editedSplitModel = parseTranscript(await readFile(sessionFile, 'utf8'), { home: os.homedir(), sessionId });
  await mkdir('/private/tmp/show-context-conversation', { recursive: true });
  await chmod(fake, 0o755);
});

after(() => {
  for (const child of servers) child.kill('SIGTERM');
});

test('multi-file shell reads split into addressable files without guessing changed output', () => {
  const split = splitModel.reads.find(read => read.toolUseIds.includes('conversation-split'));
  const changed = splitModel.reads.find(read => read.toolUseIds.includes('conversation-changed'));
  assert.deepEqual(split.files.map(file => [file.name, file.text, file.ref]), [
    ['a.md', splitFiles['a.md'], `${split.ref}.1`],
    ['b.md', splitFiles['b.md'], `${split.ref}.2`],
    ['c.txt', splitFiles['c.txt'], `${split.ref}.3`],
    ['other output', 'a.md\nb.md\nc.txt', `${split.ref}.4`]
  ]);
  assert.equal(changed.files.length, 1);
  const edited = editedSplitModel.reads.find(read => read.toolUseIds.includes('conversation-split'));
  assert.deepEqual(edited.files.map(file => [file.name, file.text]), [
    ...Object.entries(splitFiles), ['other output', 'a.md\nb.md\nc.txt\n']
  ]);

  const prompt = buildAskPrompt(splitModel, {
    kind: 'text',
    question: 'Where?',
    text: 'Beta cited line',
    messageIndex: 2
  });
  for (const file of split.files) {
    assert.match(prompt, new RegExp(`${file.ref.replace('.', '\\.') }\\s+Bash\\s+`));
    assert.match(prompt, new RegExp(file.path.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const answer = validateAskAnswer(JSON.stringify({
    summary: 'The Markdown file contains the source.',
    citations: [{
      ref: `${split.ref}.2`,
      quote: 'Beta cited line',
      kind: 'copied',
      explanation: 'The second Markdown file contains the line.'
    }]
  }), splitModel);
  assert.equal(answer.citations[0].fileRef, `${split.ref}.2`);
  assert.equal(answer.citations[0].lineStart, 3);
  assert.equal(answer.citations[0].lineEnd, 3);
});

test('live server exits from the CLI fast and protects every route', async () => {
  const started = Date.now();
  const run = start([], { SHOW_CONTEXT_CLAUDE_BIN: fake, SHOW_CONTEXT_IDLE_MS: '10000' });
  const url = await waitForUrl(run);
  servers.push(run.child);
  const exit = run.child.exitCode ?? (await new Promise(resolve => run.child.once('exit', code => resolve(code))));
  assert.equal(exit, 0);
  assert.ok(Date.now() - started < 5000);
  const parsed = new URL(url);
  assert.equal((await fetch(`${parsed.origin}/wrong/`)).status, 404);
  assert.equal(
    (
      await fetch(`${url}ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://wrong.test' },
        body: '{}'
      })
    ).status,
    403
  );
});

test('fake Claude receives exact flags, cwd, selection, and refs', async () => {
  const log = path.join(temp, 'fake.log');
  const run = start([], {
    SHOW_CONTEXT_CLAUDE_BIN: fake,
    SHOW_CONTEXT_FAKE_LOG: log,
    SHOW_CONTEXT_IDLE_MS: '10000'
  });
  const url = await waitForUrl(run);
  const origin = new URL(url).origin;
  const response = await fetch(`${url}ask`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'text', question: 'Where?', text: 'Alpha source', messageIndex: 2 })
  });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.citations.length, 4);
  assert.deepEqual(
    answer.citations.map(citation => [citation.fileRef, citation.lineStart, citation.lineEnd]),
    [
      ['r0.1', 102, 102],
      ['r0.1', 104, 104],
      ['r0.2', 2, 2],
      ['r0.3', 202, 202]
    ]
  );
  const lines = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[0].argv.slice(0, 10), [
    '--resume',
    sessionId,
    '--fork-session',
    '--no-session-persistence',
    '--print',
    '--output-format',
    'json',
    '--tools',
    '',
    '--max-turns'
  ]);
  assert.equal(lines[0].argv[10], '1');
  assert.equal(lines[0].cwd, '/private/tmp/show-context-conversation');
  assert.match(lines[1].prompt, /Alpha source/);
  assert.match(lines[1].prompt, /r0\.1\s+Read\s+\/private\/tmp\/show-context-conversation\/alpha\.mjs/);
  assert.match(lines[1].prompt, /r0\.2\s+Read\s+\/private\/tmp\/show-context-conversation\/beta\.mjs/);
  assert.match(lines[1].prompt, /r0\.3\s+Read\s+\/private\/tmp\/show-context-conversation\/gamma\.mjs/);
  assert.doesNotMatch(lines[1].prompt, /^r0\s+Read/m);
});

test('server rejects a second ask and exits when idle', async () => {
  const run = start([], {
    SHOW_CONTEXT_CLAUDE_BIN: fake,
    SHOW_CONTEXT_FAKE_WAIT_MS: '300',
    SHOW_CONTEXT_IDLE_MS: '150'
  });
  const url = await waitForUrl(run);
  const origin = new URL(url).origin;
  const request = {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'text', question: 'Why?', text: 'Alpha', messageIndex: 2 })
  };
  const first = fetch(`${url}ask`, request);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await fetch(`${url}ask`, request)).status, 409);
  assert.equal((await first).status, 200);
  await new Promise(resolve => setTimeout(resolve, 250));
  await assert.rejects(fetch(url));
});

test('conversation page renders Markdown safely and keeps static asking guidance', async () => {
  const run = start(['--static']);
  const code = await new Promise(resolve => run.child.once('exit', resolve));
  assert.equal(code, 0, `${run.stdout()} ${run.stderr()}`);
  const match = run.stdout().match(/(\/[^\s]+\.html)/);
  assert.ok(match);
  const html = await readFile(match[1], 'utf8');
  assert.match(html, /show-context-mode/);
  assert.match(html, /Asking needs the live page/);
  assert.match(html, /Conversation compacted/);
  assert.match(html, /markdownTable|<table/);
  assert.doesNotMatch(html, /<script>alert\('no'\)<\/script>/);
});

test('split Markdown tabs render and citation navigation opens source', async t => {
  if (!chrome) return t.skip('Chrome was not found. Set CHROME_PATH or install Chrome or Chromium.');
  const split = splitModel.reads.find(read => read.toolUseIds.includes('conversation-split'));
  const run = start([], { SHOW_CONTEXT_CLAUDE_BIN: fake, SHOW_CONTEXT_IDLE_MS: '10000' });
  const url = await waitForUrl(run);
  const cdp = await openCdp(`${url}?min=0`);
  try {
    await waitForValue(cdp, 'document.readyState === "complete" && Boolean(document.getElementById("m-context"))');
    await cdp.evaluate(`document.querySelector('.seg[data-ref="${split.ref}"] .body').click()`);
    const rendered = await waitForValue(cdp, `(() => {
      const row = document.querySelector('.seg[data-ref="${split.ref}"]');
      const viewer = row.nextElementSibling.querySelector('.viewer');
      if (!viewer) return null;
      return {
        tabs: viewer.querySelectorAll('.file-tab').length,
        active: viewer.querySelector('.file-tab[aria-selected="true"]').textContent.trim(),
        rendered: viewer.querySelector('.viewer-view[aria-pressed="true"]').textContent.trim(),
        heading: Boolean(viewer.querySelector('.viewer-markdown h1')),
        list: Boolean(viewer.querySelector('.viewer-markdown li')),
        table: Boolean(viewer.querySelector('.viewer-markdown table')),
        gutter: Boolean(viewer.querySelector('.viewer-line .line-no'))
      };
    })()`);
    assert.equal(rendered.tabs, 4);
    assert.equal(rendered.active, 'a.md');
    assert.equal(rendered.rendered, 'Rendered');
    assert.equal(rendered.heading, true);
    assert.equal(rendered.list, true);
    assert.equal(rendered.table, true);
    assert.equal(rendered.gutter, false);

    await cdp.evaluate(
      `document.querySelector('.seg[data-ref="${split.ref}"] + .full-wrap ` +
        `.viewer-view[data-view="source"]').click()`
    );
    assert.ok(await waitForValue(
      cdp,
      `document.querySelectorAll('.seg[data-ref="${split.ref}"] + .full-wrap .viewer-line .line-no').length`
    ));
    await cdp.evaluate(
      `document.querySelector('.seg[data-ref="${split.ref}"] + .full-wrap ` +
        `.file-tab[data-file-ref="${split.ref}.3"]').click()`
    );
    assert.equal(
      await cdp.evaluate(`Boolean(document.querySelector('.seg[data-ref="${split.ref}"] + ` +
        `.full-wrap .viewer-views'))`),
      false
    );

    await cdp.evaluate(`(() => {
      document.getElementById('m-conv').click();
      const tool = document.querySelector('.tool[data-tool-use-id="conversation-split"]');
      const node = tool.querySelector('.verb').firstChild;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    })()`);
    await waitForValue(cdp, 'document.getElementById("ask").classList.contains("on")');
    await cdp.evaluate('document.getElementById("ask-why").click()');
    await waitForValue(cdp, 'document.body.classList.contains("answered")');
    assert.equal(await cdp.evaluate('document.querySelector(".cite[data-n=\'2\'] .quote-missing").textContent'),
      'Quote not found');
    assert.equal(await waitForValue(cdp, 'document.querySelectorAll(".wire-badge").length'), 1);
    await cdp.evaluate('document.querySelector(".open-full").click()');
    const cited = await waitForValue(cdp, `(() => {
      const viewer = document.querySelector('.seg.cited + .full-wrap .viewer');
      const active = viewer?.querySelector('.file-tab[aria-selected="true"]');
      const source = viewer?.querySelector('.viewer-view[aria-pressed="true"]');
      const line = viewer?.querySelector('.viewer-line.viewer-cited[data-line="3"]');
      if (!active || !source || !line) return null;
      const view = line.closest('.viewer-scroll').getBoundingClientRect();
      const rect = line.getBoundingClientRect();
      return {
        active: active.textContent.trim(),
        source: source.textContent.trim(),
        visible: rect.top >= view.top && rect.bottom <= view.bottom
      };
    })()`);
    assert.equal(cited.active, 'b.md1');
    assert.equal(cited.source, 'Source');
    assert.equal(cited.visible, true);
    assert.deepEqual(cdp.exceptions, []);
  } finally {
    cdp.socket.close();
    cdp.child.kill('SIGTERM');
  }
});

test('ask screenshot artifact exists after Chrome E2E', async t => {
  if (!chrome) return t.skip('Chrome was not found. Set CHROME_PATH or install Chrome or Chromium.');
  const run = start([], { SHOW_CONTEXT_CLAUDE_BIN: fake, SHOW_CONTEXT_IDLE_MS: '10000' });
  const url = await waitForUrl(run);
  const cdp = await openCdp(url);
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    await waitForValue(cdp, 'document.readyState === "complete" && Boolean(document.getElementById("m-conv"))');
    await cdp.evaluate(`(() => {
      document.getElementById('m-conv').click();
      const items = document.querySelectorAll('.msg.assistant .text li');
      const range = document.createRange();
      range.setStart(items[0].firstChild, 0);
      range.setEnd(items[1].firstChild, items[1].firstChild.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    })()`);
    assert.equal(
      await waitForValue(
        cdp,
        'document.getElementById("ask").classList.contains("on") && document.getElementById("ask-label").textContent'
      ),
      'Where did this come from?'
    );
    await cdp.evaluate('document.getElementById("ask-why").click()');
    await waitForValue(cdp, 'document.body.classList.contains("answered")');
    await waitForValue(cdp, 'document.querySelectorAll("#wires path").length');
    const state = await cdp.evaluate(`({
      split: document.body.classList.contains('mode-split'),
      selected: [...document.querySelectorAll('mark.q')].map(mark => mark.textContent).join(' '),
      cardText: document.querySelector('#answer .a-sel').textContent,
      pieces: document.querySelectorAll('mark.q').length,
      sources: document.querySelectorAll('.excerpt-source.src').length,
      citedOpen: Boolean(document.querySelector('.seg.cited.open')),
      paths: document.querySelectorAll('#wires path').length,
      excerpts: [...document.querySelectorAll('.excerpt')].map(item => ({
        n: Number(item.dataset.n),
        badge: item.querySelector('.num').textContent,
        header: item.querySelector('.excerpt-title').textContent.trim(),
        top: item.getBoundingClientRect().top,
        bottom: item.getBoundingClientRect().bottom
      })),
      badges: [...document.querySelectorAll('.excerpt .num')].filter(item => {
        const rect = item.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      }).length,
      lineLabels: [...document.querySelectorAll('.c-line')].map(item => item.textContent.trim()),
      cardNumbers: [...document.querySelectorAll('.cite .num')].map(item => Number(item.textContent)),
      wireBadges: [...document.querySelectorAll('.wire-badge')].map(item => {
        const rect = item.getBoundingClientRect();
        const source = document.querySelector('.excerpt-source[data-n="' + item.dataset.n + '"]').getBoundingClientRect();
        return { y: rect.top + rect.height / 2, sourceY: source.top + source.height / 2 };
      }),
      wireEnds: [...document.querySelectorAll('#wires path')].map(path => {
        const values = path.getAttribute('d').match(/-?\\d+(?:\\.\\d+)?/g).map(Number);
        return { x: values.at(-2), y: values.at(-1) };
      }),
      readsRect: (() => {
        const rect = document.getElementById('reads-pane').getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      })()
    })`);
    assert.equal(state.split, true);
    assert.equal(state.selected, 'Alpha source Second source');
    assert.equal(state.cardText, 'Alpha source Second source');
    const askRequest = cdp.requests.find(request => request.method === 'POST' && request.url === `${url}ask`);
    assert.equal(JSON.parse(askRequest.postData).text, 'Alpha source Second source');
    assert.equal(state.pieces, 2);
    assert.equal(state.sources, 5);
    assert.equal(state.citedOpen, true);
    assert.equal(state.paths, 5);
    const labels = [
      'guide.txt L1',
      'alpha.mjs L102',
      'alpha.mjs L104',
      'beta.mjs L2',
      'gamma.mjs L202'
    ];
    assert.deepEqual(state.excerpts.map(item => item.header), labels);
    assert.ok(state.excerpts.every(item => item.top >= 0 && item.bottom <= 800));
    assert.deepEqual(state.excerpts.map(item => item.n), [1, 2, 3, 4, 5]);
    assert.deepEqual(state.excerpts.map(item => Number(item.badge)), state.cardNumbers);
    assert.ok(state.excerpts.every((item, index, items) => !index || item.top > items[index - 1].top));
    assert.equal(state.badges, 5);
    assert.deepEqual(state.lineLabels, labels);
    assert.deepEqual(state.cardNumbers, [1, 2, 3, 4, 5]);
    assert.equal(state.wireBadges.length, 5);
    assert.ok(state.wireBadges.every(({ y, sourceY }) => Math.abs(y - sourceY) <= 30));
    const positions = state.wireBadges.map(({ y }) => y).sort((a, b) => a - b);
    assert.ok(positions.every((y, index) => !index || y - positions[index - 1] >= 20));
    assert.ok(
      state.wireEnds.every(point =>
        point.x >= state.readsRect.left && point.x <= state.readsRect.right &&
        point.y >= state.readsRect.top && point.y <= state.readsRect.bottom
      )
    );
    const activeSource = n => waitForValue(cdp, '(' + String(number => {
      const item = document.querySelector('.cite[aria-current="true"]');
      const source = document.querySelector('.excerpt-source[data-n="' + number + '"]');
      const pane = document.getElementById('reads-pane').getBoundingClientRect();
      const rect = source.getBoundingClientRect();
      return Number(item?.dataset.n) === number && rect.top >= pane.top && rect.bottom <= pane.bottom;
    }) + ')(' + n + ')');
    await activeSource(1);
    assert.equal(await cdp.evaluate('document.querySelector(".source-position").textContent'), '1 of 5');
    assert.equal(await cdp.evaluate('document.querySelector(".excerpt[data-n=\'1\'] .open-full").textContent'),
      'Open full text');
    await cdp.evaluate('document.querySelector(".excerpt[data-n=\'1\'] .open-full").click()');
    assert.match(await cdp.evaluate('document.querySelector(".viewer-line.viewer-cited").textContent'),
      /Follow the local guide/);
    await cdp.evaluate('document.querySelector(".viewer-close").click()');
    const next = '[aria-label="Next source"]';
    const previous = '[aria-label="Previous source"]';
    await cdp.evaluate('document.querySelector(' + JSON.stringify(next) + ').click()');
    await activeSource(2);
    await cdp.evaluate('document.querySelector(' + JSON.stringify(previous) + ').click()');
    await activeSource(1);
    await cdp.evaluate('document.querySelector(' + JSON.stringify(previous) + ').click()');
    await activeSource(5);
    await cdp.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", {key: "]", bubbles: true}))');
    await activeSource(1);
    await cdp.evaluate('document.getElementById("reads-pane").scrollTo({top: 10000, behavior: "instant"})');
    const pinned = await waitForValue(cdp, `(() => {
      const badge = document.querySelector('.wire-badge[data-n="1"][data-pin="up"]');
      if (!badge) return null;
      const circle = badge.querySelector('circle').getBoundingClientRect();
      const top = document.getElementById('reads-pane').getBoundingClientRect().top;
      return { x: circle.left + circle.width / 2, y: circle.top + circle.height / 2, top,
        opacity: badge.getAttribute('opacity'), arrow: badge.textContent.includes('↑') };
    })()`);
    assert.ok(pinned.y - pinned.top <= 24);
    assert.equal(pinned.opacity, '0.5');
    assert.equal(pinned.arrow, true);
    const { x, y } = pinned;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await activeSource(1);
    await cdp.evaluate('document.querySelector(".excerpt[data-n=\'3\'] .open-full").click()');
    const viewer = await waitForValue(cdp, `(() => {
      const active = document.querySelector('.file-tab[aria-selected="true"]');
      const line = document.querySelector('.viewer-line.viewer-cited[data-line="104"]');
      const beta = [...document.querySelectorAll('.file-tab')].find(tab => tab.textContent.includes('beta.mjs'));
      if (!active || !line || !beta) return null;
      const view = line.closest('.viewer-scroll').getBoundingClientRect();
      const rect = line.getBoundingClientRect();
      return {
        active: active.textContent.trim(),
        beta: beta.textContent.trim(),
        visible: rect.top >= view.top && rect.bottom <= view.bottom
      };
    })()`);
    assert.match(viewer.active, /alpha\.mjs/);
    assert.match(viewer.beta, /4/);
    assert.equal(viewer.visible, true);
    await cdp.evaluate('document.querySelector(".viewer-close").click()');
    assert.equal(await waitForValue(cdp, 'document.querySelectorAll(".excerpt").length'), 5);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.evaluate('document.querySelector(".cite[data-n=\'1\']").click()');
    await activeSource(1);
    await waitForValue(cdp, 'document.querySelector(".wire-badge[data-n=\'1\']").getAttribute("data-pin") === ""');
    const capture = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const reportDir = path.join(repo, 'e2e/.local/report');
    await mkdir(reportDir, { recursive: true });
    const reportScreenshot = path.join(reportDir, 'show-context-ask.png');
    const png = Buffer.from(capture.data, 'base64');
    assert.equal(png.readUInt32BE(16), 1280);
    assert.equal(png.readUInt32BE(20), 800);
    await writeFile(reportScreenshot, png);
    assert.ok((await stat(reportScreenshot)).size > 10_000);
    await cdp.evaluate(`(() => {
      document.querySelector('.a-close').click();
      document.getElementById('m-context').click();
      const row = document.querySelector('.seg[data-ref="r0"] .body');
      row.click();
      return true;
    })()`);
    assert.equal(await waitForValue(cdp, 'document.querySelectorAll(".file-tab").length'), 3);
    await cdp.evaluate(`(() => {
      document.getElementById('m-conv').click();
      const summary = document.querySelector('.tool summary');
      const node = summary.querySelector('.verb').firstChild;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, node.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    })()`);
    assert.equal(
      await waitForValue(
        cdp,
        'document.getElementById("ask").classList.contains("on") && document.getElementById("ask-label").textContent'
      ),
      'Why was this called?'
    );
    assert.equal(await cdp.evaluate('document.querySelector(".tool").open'), false);
    const staticOut = path.join(temp, 'static.html');
    const staticRun = start(['--static'], { SHOW_CONTEXT_OUT: staticOut });
    await new Promise(resolve => staticRun.child.once('exit', resolve));
    await cdp.send('Page.navigate', { url: `file://${staticOut}` });
    await waitForValue(cdp, 'document.readyState === "complete" && Boolean(document.getElementById("m-conv"))');
    await cdp.evaluate(
      `(() => {
        document.getElementById('m-conv').click();
        const node = document.querySelector('.msg.assistant .text li').firstChild;
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return true;
      })()`
    );
    await waitForValue(cdp, 'document.getElementById("ask").classList.contains("on")');
    await cdp.evaluate('document.getElementById("ask-why").click()');
    assert.match(
      await waitForValue(
        cdp,
        'document.getElementById("answer").textContent.includes("Asking needs") && ' +
          'document.getElementById("answer").textContent'
      ),
      /Asking needs the live page/
    );
    assert.deepEqual(cdp.exceptions, []);
  } finally {
    cdp.socket.close();
    cdp.child.kill('SIGTERM');
  }
});

test('demo answer resolves every citation and produces the public ask screenshot', async t => {
  if (!chrome) return t.skip('Chrome was not found. Set CHROME_PATH or install Chrome or Chromium.');
  const run = start([], {
    SHOW_CONTEXT_CLAUDE_BIN: fake,
    SHOW_CONTEXT_FAKE_ANSWER: demoAnswer,
    SHOW_CONTEXT_IDLE_MS: '10000'
  }, demoSessionId);
  const url = await waitForUrl(run);
  const cdp = await openCdp(url);
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: 'light' },
        { name: 'prefers-reduced-motion', value: 'reduce' }
      ]
    });
    await waitForValue(cdp, 'document.readyState === "complete" && Boolean(document.getElementById("m-conv"))');
    await cdp.evaluate(`(() => {
      document.getElementById('m-conv').click();
      const message = document.querySelector('.msg.assistant[data-msg="17"] .text');
      message.scrollIntoView({ block: 'center' });
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    const selected = await cdp.evaluate(`(() => {
      const message = document.querySelector('.msg.assistant[data-msg="17"] .text');
      const node = message.firstElementChild || message;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return selection.toString();
    })()`);
    assert.equal(
      selected,
      'The request enters the server, reaches one route handler, passes validation, calls the JSON store, and returns one JSON response.'
    );
    assert.equal(
      await waitForValue(
        cdp,
        'document.getElementById("ask").classList.contains("on") && document.getElementById("ask-label").textContent'
      ),
      'Where did this come from?'
    );
    await cdp.evaluate('document.getElementById("ask-why").click()');
    await waitForValue(cdp, 'document.body.classList.contains("answered")');
    await waitForValue(cdp, 'document.querySelectorAll(".excerpt-source.src").length === 3');
    await waitForValue(cdp, 'document.querySelectorAll("#wires path").length === 3');
    const state = await cdp.evaluate(`({
      split: document.body.classList.contains('mode-split'),
      selected: [...document.querySelectorAll('mark.q')].map(mark => mark.textContent).join(' '),
      citations: document.querySelectorAll('.cite').length,
      missing: document.querySelectorAll('.quote-missing').length,
      sources: document.querySelectorAll('.excerpt-source.src').length,
      paths: document.querySelectorAll('#wires path').length,
      headers: [...document.querySelectorAll('.excerpt-title')].map(item => item.textContent.trim()),
      excerptsVisible: [...document.querySelectorAll('.excerpt')].every(item => {
        const rect = item.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      })
    })`);
    assert.equal(state.split, true);
    assert.equal(state.selected, selected);
    assert.equal(state.citations, 3);
    assert.equal(state.missing, 0);
    assert.equal(state.sources, 3);
    assert.equal(state.paths, 3);
    assert.deepEqual(state.headers, ['server.js L1', 'todos.js L1', 'storage.js L1']);
    assert.equal(state.excerptsVisible, true);
    assert.deepEqual(cdp.exceptions, []);

    const capture = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const reportDir = path.join(repo, 'e2e/.local/report');
    await mkdir(reportDir, { recursive: true });
    const reportScreenshot = path.join(reportDir, 'screenshot-ask-demo.png');
    const publicScreenshot = path.join(repo, 'docs/screenshot-ask.png');
    const png = Buffer.from(capture.data, 'base64');
    assert.equal(png.readUInt32BE(16), 1280);
    assert.equal(png.readUInt32BE(20), 800);
    await writeFile(reportScreenshot, png);
    assert.ok((await stat(reportScreenshot)).size > 10_000);
    if (process.env.UPDATE_SCREENSHOTS === '1') {
      await copyFile(reportScreenshot, publicScreenshot);
      assert.deepEqual(await readFile(publicScreenshot), png);
    }
  } finally {
    cdp.socket.close();
    cdp.child.kill('SIGTERM');
  }
});
