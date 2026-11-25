#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTranscript } from '../src/show-context.mjs';
import { renderShowContextPage } from '../src/show-context-page.mjs';
import { startServer } from '../src/server.mjs';
import { allSessions, projectsRoot } from '../src/sessions.mjs';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const help = `Show a Claude Code conversation and the context it read.

Usage: bsd-ims [session-id-or-prefix] [--no-open] [--static]
       bsd-ims --stop

The live page has a menu of all sessions, grouped by project. One local server
serves every session and stops after an hour without use.

Flags:
  --no-open       Do not open the report.
  --static        Write a static report without a live server.
  --stop          Stop the live server.
  -h, --help      Show this help.
  -v, --version   Show the version.

Environment:
  SHOW_CONTEXT_OUT          Set the report output path.
  SHOW_CONTEXT_PROJECTS     Set the Claude projects root.
  CONTEXT_LENS_ROOT         Set the old fallback projects root.
  SHOW_CONTEXT_PORT         Set the live server port.
  SHOW_CONTEXT_IDLE_MS      Set the live server idle timeout in milliseconds (default: 1 hour).
  SHOW_CONTEXT_CLAUDE_BIN   Set the Claude CLI binary.

Example:
  bsd-ims abc123 --no-open
`;

function openTarget(target) {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function outputPath() {
  return path.resolve(process.env.SHOW_CONTEXT_OUT || path.join(os.homedir(), '.cache/bsd-ims/bsd-ims.html'));
}

// The live server is shared by all runs. Its address is kept next to the output page.
function stateFileFor(output) {
  return path.join(path.dirname(output), 'server.json');
}

// A running server is reused only if it has the same version, projects root and SHOW_CONTEXT_* settings.
function serverKey(root) {
  const settings = Object.keys(process.env)
    .filter(name => name.startsWith('SHOW_CONTEXT_') && name !== 'SHOW_CONTEXT_OUT')
    .sort().map(name => [name, process.env[name]]);
  return createHash('sha256').update(JSON.stringify([packageJson.version, root, settings])).digest('hex');
}

function request(url, method = 'GET') {
  return new Promise(resolve => {
    const target = new URL(url);
    const call = http.request(target, { method, headers: { origin: target.origin }, timeout: 2000 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: response.statusCode, body: null }); }
      });
    });
    call.on('timeout', () => call.destroy());
    call.on('error', () => resolve(null));
    call.end();
  });
}

async function readState(stateFile) {
  try { return JSON.parse(await readFile(stateFile, 'utf8')); } catch { return null; }
}

async function stopServer(url) {
  await request(`${url}stop`, 'POST');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!await request(`${url}api/ping`)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

async function liveServer(root, stateFile) {
  const key = serverKey(root);
  const state = await readState(stateFile);
  if (state?.url) {
    const ping = await request(`${state.url}api/ping`);
    if (ping?.status === 200 && ping.body?.key === key) return state.url;
    if (ping) await stopServer(state.url);
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', stateFile, key], {
    detached: true,
    env: process.env,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  });
  const url = await new Promise((resolve, reject) => {
    let line = '';
    const timeout = setTimeout(() => reject(new Error('live server did not start')), 4000);
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      line += chunk;
      const newline = line.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(line.slice(0, newline).trim());
    });
  });
  child.stdout.destroy();
  child.unref();
  await writeFile(stateFile, JSON.stringify({ url, key, pid: child.pid }), { mode: 0o600 });
  return url;
}

async function stopCommand() {
  const stateFile = stateFileFor(outputPath());
  const state = await readState(stateFile);
  if (!state?.url || !await request(`${state.url}api/ping`)) {
    await unlink(stateFile).catch(() => {});
    console.log('bsd-ims: no server running');
    return;
  }
  await stopServer(state.url);
  await unlink(stateFile).catch(() => {});
  console.log('bsd-ims: server stopped');
}

function ambiguous(matches) {
  const ids = matches.map(match => match.id).sort().join(', ');
  throw new Error(`session prefix is ambiguous: ${ids}`);
}

async function selectSession(root, idArgument) {
  const sessions = await allSessions(root);
  if (idArgument) {
    const matches = sessions.filter(session => session.id.startsWith(idArgument));
    if (!matches.length) throw new Error(`session not found: ${idArgument}`);
    if (matches.length > 1) ambiguous(matches);
    return { session: matches[0], guessed: false };
  }
  if (process.env.CLAUDE_CODE_SESSION_ID) {
    const id = process.env.CLAUDE_CODE_SESSION_ID;
    const matches = sessions.filter(session => session.id === id);
    if (!matches.length) throw new Error(`session not found: ${id}`);
    if (matches.length > 1) ambiguous(matches);
    return { session: matches[0], guessed: false };
  }
  const slug = path.resolve(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
  // Exact match first; otherwise ignore case (Windows may store the drive letter as c-- instead of C--).
  let inFolder = sessions.filter(session => session.project === slug);
  if (!inFolder.length) inFolder = sessions.filter(session => session.project.toLowerCase() === slug.toLowerCase());
  const matches = inFolder
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  if (!matches.length) throw new Error('no session found for this folder');
  return { session: matches[0], guessed: true };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--serve') {
    const [, stateFile, key] = args;
    const { url } = await startServer({ root: projectsRoot(), key, version: packageJson.version, stateFile });
    process.stdout.write(`${url}\n`);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(help);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }
  if (args.includes('--stop')) {
    await stopCommand();
    return;
  }
  const flags = new Set(['--no-open', '--static']);
  const unknownFlag = args.find(argument => argument.startsWith('-') && !flags.has(argument));
  if (unknownFlag) throw new Error(`unknown flag: ${unknownFlag}. Use --help for help.`);
  const noOpen = args.includes('--no-open');
  const staticOnly = args.includes('--static');
  const positional = args.filter(argument => !flags.has(argument));
  if (positional.length > 1) {
    throw new Error('usage: bsd-ims [session-id-or-prefix] [--no-open] [--static]');
  }
  const root = projectsRoot();
  const { session, guessed } = await selectSession(root, positional[0]);
  let source;
  try { source = await readFile(session.file, 'utf8'); }
  catch { throw new Error(`cannot read transcript: ${session.id}`); }
  const model = parseTranscript(source, { sessionId: session.id, home: os.homedir() });
  const html = renderShowContextPage(model);
  const output = outputPath();
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, html, { mode: 0o600 });
  let target = output;
  if (!staticOnly) {
    const url = await liveServer(root, stateFileFor(output));
    target = `${url}?session=${encodeURIComponent(session.id)}`;
  }
  if (!noOpen) await openTarget(target);
  const note = guessed ? ' · guessed: newest session in this folder' : '';
  console.log(
    `bsd-ims: ${model.reads.length} reads, ${model.totalReadTokens} tokens` +
    ` · ${session.id.slice(0, 8)}${note} · ${target} · ${output}`
  );
}

try {
  await main();
} catch (error) {
  console.log(`bsd-ims: ${String(error?.message || error).replaceAll(/\s+/g, ' ').trim()}`);
  process.exitCode = 1;
}
