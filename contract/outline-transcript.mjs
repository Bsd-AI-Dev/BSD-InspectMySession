#!/usr/bin/env node
// outline-transcript.mjs
// Prints the structure of one Claude Code transcript, one line per record, without any message text,
// so it can be shared to debug a format change. Node.js built-ins only.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HELP = `Print the structure of a Claude Code transcript without its text.

Usage: node outline-transcript.mjs <session.jsonl | session-id-prefix> [--first N] [--projects DIR]

  --first N        Only the first N records (default: all).
  --projects DIR   Claude projects folder (default: SHOW_CONTEXT_PROJECTS or ~/.claude/projects).

Shown per record: type, subtype, flags, role, model, block types, tool names, token usage numbers,
querySource, shape hash, attachment type and field names. Never shown: message text, tool input
values, tool results, file contents.
`;

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
  process.stdout.write(HELP);
  process.exit(args.length ? 0 : 1);
}
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
};
const first = Number(option('--first')) || Infinity;
const projects = path.resolve(option('--projects') || process.env.SHOW_CONTEXT_PROJECTS || path.join(os.homedir(), '.claude', 'projects'));
const target = args[0];

function findFile(value) {
  if (existsSync(value) && value.endsWith('.jsonl')) return value;
  const matches = [];
  for (const folder of readdirSync(projects, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const file of readdirSync(path.join(projects, folder.name))) {
      if (file.endsWith('.jsonl') && file.startsWith(value)) matches.push(path.join(projects, folder.name, file));
    }
  }
  if (matches.length !== 1) {
    console.error(matches.length ? `Ambiguous prefix: ${matches.join(', ')}` : `No session found for "${value}" in ${projects}`);
    process.exit(1);
  }
  return matches[0];
}

const usageText = usage => {
  if (!usage) return '';
  const n = key => Number(usage[key]) || 0;
  const total = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
  return `usage=${total} (in ${n('input_tokens')}, cache_read ${n('cache_read_input_tokens')}, cache_create ${n('cache_creation_input_tokens')}, out ${n('output_tokens')})`;
};

function blocksText(content) {
  if (typeof content === 'string') return `content=string(${content.length} chars)`;
  if (!Array.isArray(content)) return content == null ? '' : `content=${typeof content}`;
  return 'blocks=[' + content.map(block => {
    if (!block || typeof block !== 'object') return typeof block;
    if (block.type === 'tool_use') return `tool_use:${block.name}`;
    if (block.type === 'tool_result') {
      const size = typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content ?? '').length;
      return `tool_result(${size} chars${block.is_error ? ', error' : ''})`;
    }
    if (block.type === 'text') return `text(${String(block.text || '').length} chars)`;
    return block.type || 'untyped';
  }).join(', ') + ']';
}

const file = findFile(target);
const lines = readFileSync(file, 'utf8').split('\n');
console.log(`File: ${file}`);
let shown = 0;
for (const [index, line] of lines.entries()) {
  if (!line.trim()) continue;
  if (shown++ >= first) break;
  let record;
  try { record = JSON.parse(line); } catch { console.log(`${index + 1}: (not JSON)`); continue; }
  const parts = [`${index + 1}: ${record.type ?? '(no type)'}`];
  if (record.subtype) parts.push(`subtype=${record.subtype}`);
  for (const flag of ['isSidechain', 'isMeta', 'isApiErrorMessage', 'isCompactSummary']) if (record[flag]) parts.push(flag);
  if (record.querySource) parts.push(`querySource=${record.querySource}`);
  if (record.shapeHash) parts.push(`shapeHash=${String(record.shapeHash).slice(0, 8)}`);
  if (record.version) parts.push(`v${record.version}`);
  const message = record.message;
  if (message && typeof message === 'object') {
    if (message.role) parts.push(`role=${message.role}`);
    if (message.model) parts.push(`model=${message.model}`);
    if (message.id) parts.push(`msg=${String(message.id).slice(-6)}`);
    const blocks = blocksText(message.content);
    if (blocks) parts.push(blocks);
    const usage = usageText(message.usage);
    if (usage) parts.push(usage);
  }
  if (record.type === 'api-request-shape' && record.shape) {
    parts.push(`shape: system=${record.shape.system?.length ?? 'none'} blocks, tools=${record.shape.tools?.length ?? 'none'}`);
  }
  if (record.type === 'api-request') parts.push(`tail=${Array.isArray(record.tail) ? record.tail.length : 'none'}`);
  if (record.attachment && typeof record.attachment === 'object') {
    parts.push(`attachment=${record.attachment.type ?? '?'} {${Object.keys(record.attachment).filter(key => key !== 'type').join(', ')}}`);
  }
  if (!message && !record.attachment && !['api-request', 'api-request-shape', 'api-request-blob'].includes(record.type)) {
    parts.push(`{${Object.keys(record).filter(key => !['type', 'subtype', 'uuid', 'parentUuid', 'sessionId', 'timestamp', 'cwd', 'version'].includes(key)).join(', ')}}`);
  }
  console.log(parts.join(' | '));
}
