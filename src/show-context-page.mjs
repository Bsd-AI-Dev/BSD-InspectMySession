import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./show-context.css', import.meta.url), 'utf8');
const client = readFileSync(new URL('./show-context.client.js', import.meta.url), 'utf8');

function safeJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

export function renderShowContextPage(model, options = {}) {
  const data = { ...model, live: options.live === true };
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>What Claude read</title>
<style>
${css}</style>
</head>
<body class="mode-context">
<header>
  <h1>What Claude read<span id="total"></span></h1>
  <div class="modes" role="group" aria-label="View">
    <button id="m-conv" type="button" aria-pressed="false">Conversation</button>
    <button id="m-context" type="button" aria-pressed="true">Show context</button>
  </div>
  <div class="legend" id="legend"></div>
  <button class="theme" id="theme" type="button">Light theme</button>
</header>
<div class="app">
  <section class="pane" id="conv-pane"><div class="inner" id="conv"></div></section>
  <section class="pane" id="reads-pane"><div class="inner"><div class="stack" id="stack"></div></div></section>
</div>
<aside id="filter-panel">
    <p class="panel-title">Hide everything smaller than</p>
    <label class="amount">
      <input id="amount" inputmode="numeric" aria-label="Minimum tokens" value="0">
      <span>tokens</span>
    </label>
    <div class="range">
      <span class="end">0</span>
      <input class="slider" id="min" type="range" min="0" max="1000" step="1" value="0" aria-label="Minimum tokens">
      <span class="end" id="max-end"></span>
    </div>
</aside>
<div class="ask" id="ask">
  <button class="why" id="ask-why" type="button">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <circle cx="7" cy="7" r="4.6"/>
      <path d="m10.4 10.4 3.4 3.4"/>
    </svg>
    <span id="ask-label">Where did this come from?</span>
  </button>
  <span class="sep"></span>
  <button class="chat" id="ask-chat" type="button" aria-label="Ask your own question" title="Ask your own question">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
      <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/>
    </svg>
  </button>
  <span class="field">
    <input id="ask-input" placeholder="Ask about this..." aria-label="Your question">
    <button class="send" id="ask-send" type="button" aria-label="Send">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>
      </svg>
    </button>
  </span>
</div>
<svg id="wires"></svg>
<div class="answer" id="answer" role="dialog" aria-label="Answer"></div>
<div class="ask-wait" id="ask-wait" role="status" aria-live="polite">
  <div class="ask-wait-box">
    <span class="spinner" aria-hidden="true"></span>
    <p class="ask-wait-title">Claude is analyzing…</p>
    <p class="ask-wait-note">A copy of this session is looking for the source. This can take up to 3 minutes.</p>
    <p class="ask-wait-time" id="ask-wait-time">0:00</p>
    <button type="button" id="ask-cancel">Cancel</button>
  </div>
</div>
<script id="show-context-data" type="application/json">${safeJson(data)}</script>
<script>
${client}</script>
</body>
</html>
`;
}
