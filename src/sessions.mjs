import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function projectsRoot() {
  return path.resolve(process.env.SHOW_CONTEXT_PROJECTS
    || process.env.CONTEXT_LENS_ROOT
    || path.join(os.homedir(), '.claude/projects'));
}

export async function allSessions(root) {
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
        id: entry.name.slice(0, -6), file, project: project.name, mtimeMs: details.mtimeMs, size: details.size
      });
    }
  }
  return sessions;
}

// Title, folder and source of a session, read from the start of its transcript only.
const HEAD_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 300_000;
const NOT_A_PROMPT = /^<(?:ide_|system-reminder|local-command|command-)|^Caveat:|^Base directory for this skill:/;
const metaCache = new Map();

function promptText(record) {
  if (record.type !== 'user' || record.isMeta || record.isSidechain === true || !record.message) return '';
  const content = record.message.content;
  const texts = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.filter(part => part?.type === 'text' && part.text).map(part => part.text) : [];
  for (const text of texts) {
    const value = String(text).trim();
    if (value && !NOT_A_PROMPT.test(value)) return value.replace(/\s+/g, ' ').slice(0, 300);
  }
  return '';
}

export async function sessionMeta(session) {
  const cacheKey = `${session.file}|${session.mtimeMs}|${session.size}`;
  if (metaCache.has(cacheKey)) return metaCache.get(cacheKey);
  const meta = { title: '', cwd: '', entrypoint: '' };
  let handle;
  try {
    handle = await open(session.file, 'r');
    const buffer = Buffer.alloc(Math.min(HEAD_BYTES, session.size || HEAD_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (bytesRead === buffer.length) lines.pop();
    for (const line of lines.slice(0, 400)) {
      if (!line.trim() || line.length > MAX_LINE) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!meta.cwd && typeof record.cwd === 'string') meta.cwd = record.cwd;
      if (!meta.entrypoint && typeof record.entrypoint === 'string') meta.entrypoint = record.entrypoint;
      if (!meta.title) meta.title = promptText(record);
      if (meta.title && meta.cwd && meta.entrypoint) break;
    }
  } catch {
    // An unreadable transcript still appears in the menu, without details.
  } finally {
    await handle?.close();
  }
  metaCache.set(cacheKey, meta);
  return meta;
}

function sourceLabel(entrypoint) {
  if (/vscode/i.test(entrypoint)) return 'vsc';
  if (/cli/i.test(entrypoint)) return 'cli';
  return entrypoint ? entrypoint.slice(0, 4) : '-';
}

// Sessions grouped by project folder: newest session first inside a group, newest group first.
export async function sessionGroups(root) {
  const groups = new Map();
  for (const session of await allSessions(root)) {
    if (!session.size) continue;
    const meta = await sessionMeta(session);
    if (!groups.has(session.project)) groups.set(session.project, { folder: session.project, name: '', cwd: '', sessions: [] });
    const group = groups.get(session.project);
    if (!group.cwd && meta.cwd) {
      group.cwd = meta.cwd;
      group.name = meta.cwd.split(/[\\/]/).filter(Boolean).pop() || '';
    }
    group.sessions.push({
      id: session.id, file: session.file, mtimeMs: session.mtimeMs, size: session.size,
      title: meta.title || '(no prompt found)', source: sourceLabel(meta.entrypoint)
    });
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.name ||= group.folder;
    group.sessions.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  }
  return list.sort((a, b) => b.sessions[0].mtimeMs - a.sessions[0].mtimeMs || a.folder.localeCompare(b.folder));
}
