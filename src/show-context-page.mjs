import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./show-context.css', import.meta.url), 'utf8');
const client = readFileSync(new URL('./show-context.client.js', import.meta.url), 'utf8');

function safeJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

export function renderShowContextPage(model) {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>What Claude read</title>
<style>
${css}</style>
</head>
<body>
<div class="page">
  <main>
    <header><h1>What Claude read<span id="total"></span></h1><div class="legend" id="legend"></div><button class="theme" id="theme" type="button">Dark theme</button></header>
    <div class="stack" id="stack"></div>
  </main>
  <aside>
    <p class="panel-title">Hide everything smaller than</p>
    <label class="amount"><input id="amount" inputmode="numeric" aria-label="Minimum tokens" value="0"><span>tokens</span></label>
    <div class="range"><span class="end">0</span><input class="slider" id="min" type="range" min="0" max="1000" step="1" value="0" aria-label="Minimum tokens"><span class="end" id="max-end"></span></div>
  </aside>
</div>
<script id="show-context-data" type="application/json">${safeJson(model)}</script>
<script>
${client}</script>
</body>
</html>
`;
}
