#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseTranscript } from '../src/show-context.mjs';
import { renderShowContextPage } from '../src/show-context-page.mjs';

const runFile = promisify(execFile);

function projectsRoot() {
  return path.resolve(process.env.SHOW_CONTEXT_PROJECTS
    || process.env.CONTEXT_LENS_ROOT
    || path.join(os.homedir(), '.claude/projects'));
}

async function allSessions(root) {
  const sessions = [];
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); }
  catch { throw new Error(`cannot read projects root: ${root}`); }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const folder = path.join(root, project.name);
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(folder, entry.name);
      const details = await stat(file);
      sessions.push({
        id: entry.name.slice(0, -6), file, project: project.name, mtimeMs: details.mtimeMs
      });
    }
  }
  return sessions;
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
  const slug = path.resolve(process.cwd()).replaceAll('/', '-').replaceAll('.', '-');
  const matches = sessions.filter(session => session.project === slug).sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  if (!matches.length) throw new Error('no session found for this folder');
  return { session: matches[0], guessed: true };
}

async function main() {
  const args = process.argv.slice(2);
  const noOpen = args.includes('--no-open');
  const positional = args.filter(argument => argument !== '--no-open');
  if (positional.length > 1 || args.some(argument => argument.startsWith('--') && argument !== '--no-open')) {
    throw new Error('usage: show-context [session-id-or-prefix] [--no-open]');
  }
  const { session, guessed } = await selectSession(projectsRoot(), positional[0]);
  let source;
  try { source = await readFile(session.file, 'utf8'); }
  catch { throw new Error(`cannot read transcript: ${session.id}`); }
  const model = parseTranscript(source, { sessionId: session.id, home: os.homedir() });
  const html = renderShowContextPage(model);
  const output = path.resolve(process.env.SHOW_CONTEXT_OUT || path.join(os.homedir(), '.cache/show-context/show-context.html'));
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, html, { mode: 0o600 });
  if (!noOpen) await runFile('open', [output]);
  const note = guessed ? ' · guessed: newest session in this folder' : '';
  console.log(`show-context: ${model.reads.length} reads, ${model.totalReadTokens} tokens · ${session.id.slice(0, 8)}${note} · ${output}`);
}

try {
  await main();
} catch (error) {
  console.log(`show-context: ${String(error?.message || error).replaceAll(/\s+/g, ' ').trim()}`);
  process.exitCode = 1;
}
