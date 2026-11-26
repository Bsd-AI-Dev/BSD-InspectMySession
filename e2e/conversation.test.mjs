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
const cli = path.join(repo, 'bin/bsd-ims.mjs');
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
const sessionPage = (url, id = sessionId) => `${url}s/${id}/`;

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

after(async () => {
  for (const child of servers) child.kill('SIGTERM');
  await runCli(['--stop'], { SHOW_CONTEXT_OUT: path.join(temp, 'x.html') });
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
      await fetch(`${sessionPage(url)}ask`, {
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
  const response = await fetch(`${sessionPage(url)}ask`, {
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
  const first = fetch(`${sessionPage(url)}ask`, request);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await fetch(`${sessionPage(url)}ask`, request)).status, 409);
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
  const cdp = await openCdp(`${sessionPage(url)}?min=0`);
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
  const cdp = await openCdp(sessionPage(url));
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
    const askRequest = cdp.requests.find(request => request.method === 'POST' && request.url === `${sessionPage(url)}ask`);
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
  const cdp = await openCdp(sessionPage(url, demoSessionId));
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

const exited = run => run.child.exitCode != null
  ? Promise.resolve(run.child.exitCode)
  : new Promise(resolve => run.child.once('exit', resolve));

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repo,
      env: { ...process.env, SHOW_CONTEXT_PROJECTS: projects, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('exit', code => resolve({ code, stdout }));
  });
}

async function gone(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await fetch(url); } catch { return true; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

test('one live server is reused, lists sessions by project and stops on request', async () => {
  const hubDir = path.join(temp, 'hub-reuse');
  await mkdir(hubDir, { recursive: true });
  const env = { SHOW_CONTEXT_CLAUDE_BIN: fake, SHOW_CONTEXT_IDLE_MS: '20000', SHOW_CONTEXT_OUT: path.join(hubDir, 'page.html') };
  const firstRun = start([], env);
  const url = await waitForUrl(firstRun);
  await exited(firstRun);
  assert.ok(firstRun.stdout().includes(`${url}?session=${sessionId}`), firstRun.stdout());
  const secondRun = start([], env, demoSessionId);
  assert.equal(await waitForUrl(secondRun), url);
  await exited(secondRun);
  assert.ok(secondRun.stdout().includes(`${url}?session=${demoSessionId}`));
  const state = JSON.parse(await readFile(path.join(hubDir, 'server.json'), 'utf8'));
  assert.equal(state.url, url);

  assert.match(await (await fetch(url)).text(), /id="sessions"/);
  const list = await (await fetch(`${url}api/sessions`)).json();
  const group = list.projects.find(project => project.folder === 'fixture');
  assert.ok(group, JSON.stringify(list));
  assert.deepEqual(group.sessions.map(session => session.id).sort(), [demoSessionId, sessionId].sort());
  assert.ok(group.sessions.every(session => session.title && session.file.endsWith('.jsonl')));
  const page = await fetch(sessionPage(url));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /show-context-data/);
  assert.equal((await fetch(sessionPage(url, 'ffffffff-0000-4000-8000-000000000000'))).status, 404);
  assert.equal((await fetch(`${url}s/..%2F..%2Fx/`)).status, 404);
  assert.equal((await fetch(`${url}stop`, { method: 'POST', headers: { origin: 'http://wrong.test' } })).status, 403);

  const otherRun = start([], { ...env, SHOW_CONTEXT_IDLE_MS: '20001' });
  const other = await waitForUrl(otherRun);
  await exited(otherRun);
  assert.notEqual(other, url);
  assert.ok(await gone(url), 'the server with other settings was replaced');

  const stopped = await runCli(['--stop'], env);
  assert.equal(stopped.code, 0);
  assert.equal(stopped.stdout, 'bsd-ims: server stopped\n');
  assert.ok(await gone(other));
  await assert.rejects(readFile(path.join(hubDir, 'server.json')));
  assert.equal((await runCli(['--stop'], env)).stdout, 'bsd-ims: no server running\n');
});

test('Stop server ends the server process, also while a question is running', async () => {
  const hubDir = path.join(temp, 'hub-stop-busy');
  await mkdir(hubDir, { recursive: true });
  const log = path.join(hubDir, 'fake.log');
  const env = {
    SHOW_CONTEXT_CLAUDE_BIN: fake,
    SHOW_CONTEXT_FAKE_WAIT_MS: '15000',
    SHOW_CONTEXT_FAKE_HELPER_MS: '15000',
    SHOW_CONTEXT_FAKE_LOG: log,
    SHOW_CONTEXT_IDLE_MS: '20000',
    SHOW_CONTEXT_OUT: path.join(hubDir, 'page.html')
  };
  const url = await waitForUrl(start([], env));
  const { pid } = JSON.parse(await readFile(path.join(hubDir, 'server.json'), 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const origin = new URL(url).origin;
  const asking = fetch(`${sessionPage(url)}ask`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'text', question: 'Where?', text: 'Alpha source', messageIndex: 2 })
  }).catch(() => null);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await readFile(log, 'utf8').catch(() => '')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal((await fetch(`${url}stop`, { method: 'POST', headers: { origin } })).status, 200);
  let running = true;
  for (let attempt = 0; attempt < 150 && running; attempt += 1) {
    running = alive();
    if (running) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(running, false, 'the server process ended within 3 seconds');
  await asking;
  await assert.rejects(readFile(path.join(hubDir, 'server.json')));
});

test('menu shows the selected session and switches sessions', async t => {
  if (!chrome) return t.skip('Chrome was not found. Set CHROME_PATH or install Chrome or Chromium.');
  const hubDir = path.join(temp, 'hub-menu');
  await mkdir(hubDir, { recursive: true });
  const env = { SHOW_CONTEXT_CLAUDE_BIN: fake, SHOW_CONTEXT_IDLE_MS: '20000', SHOW_CONTEXT_OUT: path.join(hubDir, 'page.html') };
  const url = await waitForUrl(start([], env));
  const cdp = await openCdp(`${url}?session=${sessionId}`);
  try {
    await waitForValue(cdp, 'document.querySelectorAll(".session").length === 2');
    const state = await cdp.evaluate(`({
      groups: [...document.querySelectorAll('.project')].map(node => node.dataset.folder),
      selected: document.querySelector('.session.selected')?.dataset.id,
      frame: document.querySelector('#frame').getAttribute('src')
    })`);
    assert.deepEqual(state.groups, ['fixture']);
    assert.equal(state.selected, sessionId);
    assert.equal(state.frame, `s/${sessionId}/`);
    await waitForValue(cdp, `document.querySelector('#frame').contentDocument?.getElementById('show-context-data') ? true : false`);
    await cdp.evaluate(`document.querySelector('.session[data-id="${demoSessionId}"] .open').click()`);
    assert.equal(
      await waitForValue(cdp, `document.querySelector('#frame').getAttribute('src') === 's/${demoSessionId}/' && location.search`),
      `?session=${demoSessionId}`
    );
    await cdp.evaluate(`(() => {
      const input = document.getElementById('filter');
      input.value = 'no-session-matches-this';
      input.dispatchEvent(new Event('input'));
    })()`);
    assert.equal(await cdp.evaluate('document.querySelectorAll(".session:not([hidden])").length'), 0);
    assert.deepEqual(cdp.exceptions, []);
  } finally {
    cdp.socket.close();
    cdp.child.kill('SIGTERM');
    await runCli(['--stop'], env);
  }
});

test('one theme button in the menu switches both pages, dark by default', async t => {
  if (!chrome) return t.skip('Chrome was not found. Set CHROME_PATH or install Chrome or Chromium.');
  const hubDir = path.join(temp, 'hub-theme');
  await mkdir(hubDir, { recursive: true });
  const env = { SHOW_CONTEXT_CLAUDE_BIN: fake, SHOW_CONTEXT_IDLE_MS: '20000', SHOW_CONTEXT_OUT: path.join(hubDir, 'page.html') };
  const url = await waitForUrl(start([], env));
  const cdp = await openCdp(`${url}?session=${sessionId}`);
  const themes = `({
    menu: document.documentElement.dataset.theme,
    page: document.querySelector('#frame').contentDocument?.documentElement.dataset.theme,
    button: document.getElementById('theme').textContent
  })`;
  try {
    await waitForValue(cdp, `document.querySelector('#frame').contentDocument?.getElementById('show-context-data') ? true : false`);
    await waitForValue(cdp, `document.querySelector('#frame').contentDocument.getElementById('stack')?.children.length > 0`);
    assert.deepEqual(await cdp.evaluate(themes), { menu: 'dark', page: 'dark', button: 'Light theme' });
    assert.equal(
      await cdp.evaluate(`getComputedStyle(document.querySelector('#frame').contentDocument.getElementById('theme')).display`),
      'none',
      'the session page hides its own theme button inside the menu'
    );
    await cdp.evaluate(`document.getElementById('theme').click()`);
    await waitForValue(cdp, `document.querySelector('#frame').contentDocument.documentElement.dataset.theme === 'light'`);
    assert.deepEqual(await cdp.evaluate(themes), { menu: 'light', page: 'light', button: 'Dark theme' });
    await cdp.evaluate('location.reload()');
    await waitForValue(cdp, `document.readyState === 'complete' && document.querySelector('#frame').contentDocument?.getElementById('show-context-data') ? true : false`);
    await waitForValue(cdp, `document.querySelector('#frame').contentDocument.documentElement.dataset.theme === 'light'`);
    assert.equal(await cdp.evaluate(`document.documentElement.dataset.theme`), 'light', 'the choice is remembered');
    await cdp.evaluate(`document.getElementById('theme').click()`);
    await waitForValue(cdp, `document.querySelector('#frame').contentDocument.documentElement.dataset.theme === 'dark'`);
    assert.equal(await cdp.evaluate(`document.documentElement.dataset.theme`), 'dark');
    assert.deepEqual(cdp.exceptions, []);
  } finally {
    cdp.socket.close();
    cdp.child.kill('SIGTERM');
    await runCli(['--stop'], env);
  }
});

test('asking shows a waiting popup with a timer, and Cancel stops the ask', async t => {
  if (!chrome) return t.skip('Chrome was not found. Set CHROME_PATH or install Chrome or Chromium.');
  const hubDir = path.join(temp, 'hub-wait');
  await mkdir(hubDir, { recursive: true });
  const env = {
    SHOW_CONTEXT_CLAUDE_BIN: fake,
    SHOW_CONTEXT_FAKE_WAIT_MS: '1500',
    SHOW_CONTEXT_IDLE_MS: '20000',
    SHOW_CONTEXT_OUT: path.join(hubDir, 'page.html')
  };
  const url = await waitForUrl(start([], env));
  const cdp = await openCdp(sessionPage(url));
  const select = `(() => {
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
  })()`;
  const popupOn = `document.getElementById('ask-wait').classList.contains('on')`;
  try {
    await waitForValue(cdp, 'document.readyState === "complete" && Boolean(document.getElementById("m-conv"))');
    assert.equal(await cdp.evaluate(popupOn), false);
    await cdp.evaluate(select);
    await waitForValue(cdp, 'document.getElementById("ask").classList.contains("on")');
    await cdp.evaluate('document.getElementById("ask-why").click()');
    await waitForValue(cdp, popupOn);
    assert.match(await cdp.evaluate(`document.getElementById('ask-wait').textContent`), /Analyzing your question/);
    assert.equal(await cdp.evaluate(`document.getElementById('ask-wait-time').textContent`), '0:00');
    await waitForValue(cdp, `document.getElementById('ask-wait-time').textContent === '0:01'`, 3000);
    await cdp.evaluate(`document.getElementById('ask-cancel').click()`);
    assert.equal(await cdp.evaluate(popupOn), false);
    assert.equal(await cdp.evaluate(`document.body.classList.contains('answered')`), false);
    // The server stops the Claude run, so a new ask is accepted at once instead of "already running".
    const again = await fetch(`${sessionPage(url)}ask`, {
      method: 'POST',
      headers: { origin: new URL(url).origin, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'text', question: 'Where?', text: 'Alpha source', messageIndex: 2 })
    });
    assert.equal(again.status, 200);

    await cdp.evaluate(select);
    await waitForValue(cdp, 'document.getElementById("ask").classList.contains("on")');
    await cdp.evaluate('document.getElementById("ask-why").click()');
    await waitForValue(cdp, popupOn);
    await waitForValue(cdp, `document.body.classList.contains('answered')`, 5000);
    assert.equal(await cdp.evaluate(popupOn), false, 'the popup closes when the answer arrives');
    assert.deepEqual(cdp.exceptions, []);
  } finally {
    cdp.socket.close();
    cdp.child.kill('SIGTERM');
    await runCli(['--stop'], env);
  }
});

// Sessions with a recorded last request (time, model, size, cache kind), for the model choice and the ask log.
const WARM = 'aaaaaaaa-1111-4111-8111-111111111111';
const COLD = 'aaaaaaaa-2222-4222-8222-222222222222';
const HOUR = 'aaaaaaaa-3333-4333-8333-333333333333';
const BIG = 'aaaaaaaa-4444-4444-8444-444444444444';
const NOTIME = 'aaaaaaaa-5555-4555-8555-555555555555';
const timedRoot = () => path.join(temp, 'timed-projects');

async function timedSession(id, { ageMs, ttl = '5m', model = 'claude-opus-5-5', contextTokens = 60000 } = {}) {
  const dir = path.join(timedRoot(), 'timed');
  await mkdir(dir, { recursive: true });
  const records = (await readFile(fixture, 'utf8')).trim().split('\n').map(JSON.parse);
  if (ageMs != null) {
    records.push({
      type: 'assistant',
      isSidechain: false,
      timestamp: new Date(Date.now() - ageMs).toISOString(),
      message: {
        id: `timed-${id}`,
        model,
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: contextTokens - 2015,
          cache_creation_input_tokens: 2000,
          output_tokens: 5,
          cache_creation: ttl === '1h'
            ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 }
            : { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 }
        }
      }
    });
  }
  await writeFile(path.join(dir, `${id}.jsonl`), records.map(jsonLine).join(''));
}

async function timedHub(name, extra = {}) {
  const dir = path.join(temp, name);
  await mkdir(dir, { recursive: true });
  const env = {
    SHOW_CONTEXT_CLAUDE_BIN: fake,
    SHOW_CONTEXT_IDLE_MS: '20000',
    SHOW_CONTEXT_OUT: path.join(dir, 'page.html'),
    SHOW_CONTEXT_PROJECTS: timedRoot(),
    SHOW_CONTEXT_FAKE_LOG: path.join(dir, 'fake.log'),
    ...extra
  };
  return { dir, env };
}

const askPost = (url, id, body = {}, signal) => fetch(`${sessionPage(url, id)}ask`, {
  method: 'POST',
  headers: { origin: new URL(url).origin, 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'text', question: 'Where?', text: 'Alpha source', messageIndex: 2, ...body }),
  signal
});
const saveSettings = (url, settings, origin = new URL(url).origin) => fetch(`${url}api/settings`, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify(settings)
});
const askLog = async url => (await (await fetch(`${url}api/asks`)).json()).asks;
const fakeRuns = async dir => (await readFile(path.join(dir, 'fake.log'), 'utf8')).trim().split('\n')
  .map(JSON.parse).filter(line => line.argv);
const modelFlag = argv => (argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : '');

test('an answer reports model, tokens and cost, and every ask goes to the ask log, newest first', async () => {
  await timedSession(WARM, { ageMs: 60_000 });
  const { env } = await timedHub('hub-log', { SHOW_CONTEXT_FAKE_WAIT_MS: '300' });
  const url = await waitForUrl(start([], env, WARM));
  try {
    const first = await (await askPost(url, WARM, { question: 'First?' })).json();
    assert.equal(first.model, 'claude-opus-5-5');
    assert.deepEqual(first.tokens, { input: 340, cacheRead: 48900, cacheWrite: 2900, output: 640 });
    assert.equal(first.costUsd, 0.0123);
    assert.equal(first.choice.sessionModel, 'claude-opus-5-5');
    assert.match(first.choice.reason, /cache/i);
    assert.equal((await askPost(url, WARM, { question: 'Second?' })).status, 200);
    const controller = new AbortController();
    const cancelled = askPost(url, WARM, { question: 'Third?' }, controller.signal).catch(() => null);
    setTimeout(() => controller.abort(), 100);
    await cancelled;
    let asks = [];
    for (let attempt = 0; attempt < 100 && asks.length < 3; attempt += 1) {
      asks = await askLog(url);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(asks.map(ask => [ask.question, ask.status]), [
      ['Third?', 'cancelled'],
      ['Second?', 'answered'],
      ['First?', 'answered']
    ]);
    const entry = asks[1];
    assert.equal(entry.sessionId, WARM);
    assert.equal(entry.title, 'Explain the project.');
    assert.equal(entry.text, 'Alpha source');
    assert.equal(entry.model, 'claude-opus-5-5');
    assert.equal(entry.costUsd, 0.0123);
    assert.ok(Date.parse(entry.time) > Date.now() - 60_000);
    assert.deepEqual(entry.parts.map(part => [part.label, part.tokens]), [
      ['Read from cache', 48900],
      ['Written to cache', 2900],
      ['New input', 340],
      ['Output', 640]
    ]);
    assert.ok(entry.parts.every(part => part.usd > 0));
    assert.match(entry.choice.reason, /cache/i);

    assert.equal((await saveSettings(url, { keepQuestionText: false })).status, 200);
    assert.equal((await askPost(url, WARM, { question: 'Private?' })).status, 200);
    const latest = (await askLog(url))[0];
    assert.equal(latest.status, 'answered');
    assert.equal(latest.question, '');
    assert.equal(latest.text, '');
  } finally {
    await runCli(['--stop'], env);
  }
});

test('settings are saved by the server, checked, and a chosen model is passed to Claude', async () => {
  await timedSession(WARM, { ageMs: 60_000 });
  const { dir, env } = await timedHub('hub-settings');
  const url = await waitForUrl(start([], env, WARM));
  try {
    const first = await (await fetch(`${url}api/settings`)).json();
    assert.deepEqual(first.settings, {
      askModel: 'auto',
      cacheLifetime: 'detect',
      costLimitUsd: 0.1,
      askTimeoutMinutes: 3,
      keepQuestionText: true
    });
    assert.ok(first.prices.some(price => price.model === 'claude-haiku-5-5'));
    assert.match(first.pricesUpdated, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await saveSettings(url, { askModel: 'claude-sonnet-5-5' }, 'http://wrong.test')).status, 403);
    assert.equal((await saveSettings(url, { askModel: 'not a model!' })).status, 400);
    assert.equal((await saveSettings(url, { costLimitUsd: -1 })).status, 400);
    assert.equal((await saveSettings(url, { cacheLifetime: '2h' })).status, 400);
    assert.equal((await saveSettings(url, { askModel: 'claude-sonnet-5-5' })).status, 200);
    const saved = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(saved.askModel, 'claude-sonnet-5-5');
    assert.equal(saved.costLimitUsd, 0.1);
    const answer = await (await askPost(url, WARM)).json();
    assert.equal(answer.model, 'claude-sonnet-5-5');
    assert.match(answer.choice.reason, /Settings/);
    assert.equal(modelFlag((await fakeRuns(dir)).at(-1).argv), 'claude-sonnet-5-5');
  } finally {
    await runCli(['--stop'], env);
  }
});

test('Auto uses the session model while its cache is warm and Haiku once it has expired', async () => {
  await timedSession(WARM, { ageMs: 60_000 });
  await timedSession(COLD, { ageMs: 3 * 60 * 60_000 });
  await timedSession(HOUR, { ageMs: 30 * 60_000, ttl: '1h' });
  await timedSession(BIG, { ageMs: 60_000, contextTokens: 600_000 });
  await timedSession(NOTIME);
  const { dir, env } = await timedHub('hub-auto');
  const url = await waitForUrl(start([], env, WARM));
  const plan = async id => (await fetch(`${sessionPage(url, id)}ask-model`)).json();
  try {
    const warm = await plan(WARM);
    assert.equal(warm.model, 'claude-opus-5-5');
    assert.equal(warm.sessionModel, 'claude-opus-5-5');
    assert.equal(warm.label, 'Opus 5.5');
    assert.match(warm.reason, /cache is still warm/);
    assert.ok(warm.estimate.sessionModelUsd < 0.1, JSON.stringify(warm));
    const cold = await plan(COLD);
    assert.equal(cold.model, 'claude-haiku-5-5');
    assert.equal(cold.label, 'Haiku 5.5');
    assert.match(cold.reason, /idle 3 h.*expired/);
    assert.ok(cold.estimate.sessionModelUsd > cold.estimate.haikuUsd);
    assert.equal((await plan(HOUR)).model, 'claude-opus-5-5', 'a 1-hour cache is read from the session');
    const big = await plan(BIG);
    assert.equal(big.model, 'claude-haiku-5-5');
    assert.match(big.reason, /limit/);
    const untimed = await plan(NOTIME);
    assert.equal(untimed.model, '');
    assert.match(untimed.reason, /not recorded/);

    assert.equal((await askPost(url, COLD)).status, 200);
    assert.equal((await askPost(url, COLD, { model: 'claude-opus-5-5' })).status, 200);
    assert.equal((await askPost(url, NOTIME)).status, 200);
    assert.deepEqual((await fakeRuns(dir)).map(run => modelFlag(run.argv)), ['claude-haiku-5-5', 'claude-opus-5-5', '']);
    assert.equal((await askPost(url, COLD, { model: 'bad model!' })).status, 500);

    await saveSettings(url, { cacheLifetime: '5m' });
    assert.equal((await plan(HOUR)).model, 'claude-haiku-5-5', 'the Settings value replaces detection');
    await saveSettings(url, { cacheLifetime: 'detect', costLimitUsd: 1 });
    assert.equal((await plan(COLD)).model, 'claude-opus-5-5');
    await saveSettings(url, { costLimitUsd: 0.1, askModel: 'session' });
    const session = await plan(COLD);
    assert.equal(session.model, 'claude-opus-5-5');
    assert.match(session.reason, /Settings/);
  } finally {
    await runCli(['--stop'], env);
  }
});

test('the menu has Sessions, Settings and Ask log tabs, and a log row opens a cost popup', async t => {
  if (!chrome) return t.skip('Chrome was not found. Set CHROME_PATH or install Chrome or Chromium.');
  await timedSession(WARM, { ageMs: 60_000 });
  const { env } = await timedHub('hub-tabs');
  const url = await waitForUrl(start([], env, WARM));
  await askPost(url, WARM, { question: 'First?' });
  await askPost(url, WARM, { question: 'Second?' });
  const cdp = await openCdp(`${url}?session=${WARM}`);
  const visible = id => `(() => { const node = document.getElementById('${id}'); return Boolean(node && node.offsetParent); })()`;
  try {
    await waitForValue(cdp, 'document.querySelectorAll(".session").length > 0');
    assert.deepEqual(await cdp.evaluate(`[...document.querySelectorAll('[role=tab]')].map(tab => tab.textContent.trim())`),
      ['Sessions', 'Settings', 'Ask log']);
    assert.equal(await cdp.evaluate(`document.querySelector('[role=tab][aria-selected=true]').textContent.trim()`), 'Sessions');
    assert.equal(await cdp.evaluate(visible('sessions')), true);

    await cdp.evaluate(`document.getElementById('tab-settings').click()`);
    await waitForValue(cdp, visible('panel-settings'));
    assert.equal(await cdp.evaluate(visible('sessions')), false);
    await waitForValue(cdp, `document.getElementById('set-askModel').value === 'auto'`);
    assert.match(await cdp.evaluate(`document.getElementById('panel-settings').textContent`), /Haiku 5\.5/);
    await cdp.evaluate(`(() => {
      const select = document.getElementById('set-askModel');
      select.value = 'claude-haiku-5-5';
      select.dispatchEvent(new Event('change'));
      document.getElementById('settings-save').click();
    })()`);
    await waitForValue(cdp, `document.getElementById('settings-status').textContent === 'Saved'`);
    assert.equal((await (await fetch(`${url}api/settings`)).json()).settings.askModel, 'claude-haiku-5-5');

    await cdp.evaluate(`document.getElementById('tab-log').click()`);
    await waitForValue(cdp, 'document.querySelectorAll(".ask-row").length === 2');
    assert.match(await cdp.evaluate(`document.querySelector('.ask-row').textContent`), /Second\?/);
    await cdp.evaluate(`document.querySelector('.ask-row').click()`);
    await waitForValue(cdp, `document.getElementById('ask-detail').open`);
    const detail = await cdp.evaluate(`document.getElementById('ask-detail').textContent`);
    for (const text of ['Second?', 'Alpha source', 'Opus 5.5', 'Read from cache', '48,900', '$0.0123', 'cache is still warm']) {
      assert.ok(detail.includes(text), `${text} in: ${detail}`);
    }
    await cdp.evaluate(`document.getElementById('ask-detail-close').click()`);
    assert.equal(await cdp.evaluate(`document.getElementById('ask-detail').open`), false);
    assert.deepEqual(cdp.exceptions, []);
  } finally {
    cdp.socket.close();
    cdp.child.kill('SIGTERM');
    await runCli(['--stop'], env);
  }
});

test('the waiting popup names the model, the footer shows tokens, and Try again uses the session model', async t => {
  if (!chrome) return t.skip('Chrome was not found. Set CHROME_PATH or install Chrome or Chromium.');
  await timedSession(COLD, { ageMs: 3 * 60 * 60_000 });
  const answerFile = path.join(temp, 'not-found-answer.json');
  await writeFile(answerFile, JSON.stringify({
    summary: 'Nothing matched.',
    citations: [{ ref: 'r0.1', quote: 'A quote that is not in the file', kind: 'copied', explanation: 'Guess.' }]
  }));
  const { dir, env } = await timedHub('hub-retry', { SHOW_CONTEXT_FAKE_WAIT_MS: '600', SHOW_CONTEXT_FAKE_ANSWER: answerFile });
  const url = await waitForUrl(start([], env, COLD));
  const cdp = await openCdp(sessionPage(url, COLD));
  try {
    await waitForValue(cdp, 'document.readyState === "complete" && Boolean(document.getElementById("m-conv"))');
    await cdp.evaluate(`(() => {
      document.getElementById('m-conv').click();
      const items = document.querySelectorAll('.msg.assistant .text li');
      const range = document.createRange();
      range.setStart(items[0].firstChild, 0);
      range.setEnd(items[1].firstChild, items[1].firstChild.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    })()`);
    await waitForValue(cdp, 'document.getElementById("ask").classList.contains("on")');
    await cdp.evaluate('document.getElementById("ask-why").click()');
    await waitForValue(cdp, `document.getElementById('ask-wait-model').textContent.includes('Haiku 5.5')`);
    assert.match(await cdp.evaluate(`document.getElementById('ask-wait-model').textContent`), /expired/);
    await waitForValue(cdp, `document.querySelector('#answer .a-foot') ? true : false`, 5000);
    const footer = await cdp.evaluate(`document.querySelector('#answer .a-foot').textContent`);
    for (const text of ['claude-haiku-5-5', '52,140 tokens in', '48,900 from cache', '640 out', '$0.0123']) {
      assert.ok(footer.includes(text), `${text} in: ${footer}`);
    }
    assert.equal(await cdp.evaluate(`document.getElementById('ask-retry').textContent`), 'Try again with Opus 5.5');
    await cdp.evaluate(`document.getElementById('ask-retry').click()`);
    await waitForValue(cdp, `document.getElementById('ask-wait').classList.contains('on')`);
    await waitForValue(cdp, `document.querySelector('#answer .a-foot')?.textContent.includes('claude-opus-5-5')`, 5000);
    assert.deepEqual((await fakeRuns(dir)).map(run => modelFlag(run.argv)), ['claude-haiku-5-5', 'claude-opus-5-5']);
    assert.equal(await cdp.evaluate(`document.getElementById('ask-retry')`), null, 'no second retry once the session model answered');
    assert.deepEqual(cdp.exceptions, []);
  } finally {
    cdp.socket.close();
    cdp.child.kill('SIGTERM');
    await runCli(['--stop'], env);
  }
});

test('a missing Claude Code CLI gives an answer that says how to fix it', async () => {
  const hubDir = path.join(temp, 'hub-missing-claude');
  await mkdir(hubDir, { recursive: true });
  const env = {
    SHOW_CONTEXT_CLAUDE_BIN: path.join(temp, 'no-such-claude'),
    SHOW_CONTEXT_IDLE_MS: '20000',
    SHOW_CONTEXT_OUT: path.join(hubDir, 'page.html')
  };
  const url = await waitForUrl(start([], env));
  try {
    const response = await fetch(`${sessionPage(url)}ask`, {
      method: 'POST',
      headers: { origin: new URL(url).origin, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'text', question: 'Where?', text: 'Alpha source', messageIndex: 2 })
    });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /Claude Code CLI was not found: .*no-such-claude\. .*SHOW_CONTEXT_CLAUDE_BIN/);
  } finally {
    await runCli(['--stop'], env);
  }
});
