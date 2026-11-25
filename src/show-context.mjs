import path from 'node:path';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { classifyShellCommand } from './shell-kind.mjs';
import { buildStartLoad, isSyntheticAssistant } from './start-load.mjs';

export const EXCLUDED_TOOLS = new Set([
  'Write', 'Edit', 'NotebookEdit', 'ToolSearch', 'AskUserQuestion', 'TaskOutput',
  'TaskStop', 'Agent', 'Task', 'ScheduleWakeup', 'Artifact'
]);

// MCP tool names (the part after the server) that start with one of these verbs change state.
export const MCP_WRITE_VERB = new RegExp(
  '^(write|edit|move|remove|delete|create|update|save|set|send|post|put|patch|apply|' +
    'bind|batch|merge|resolve|mark|share|unshare|retire|restore|submit)(_|$)',
  'i'
);

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.content != null) return textOf(value.content);
    return '';
  }
  return String(value);
}

function blocksOf(record) {
  const content = record.message?.content;
  if (Array.isArray(content)) return content;
  if (content == null) return [];
  return [{ type: 'text', text: textOf(content) }];
}

function conversationText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(conversationText).filter(Boolean).join('\n');
  if (value.type === 'image' || value.source?.type === 'base64') return '[image]';
  if (typeof value.text === 'string') return value.text;
  if (value.content != null) return conversationText(value.content);
  return '';
}

function totalUsage(usage = {}) {
  return (Number(usage.input_tokens) || 0)
    + (Number(usage.cache_read_input_tokens) || 0)
    + (Number(usage.cache_creation_input_tokens) || 0);
}

function homePath(value, home) {
  if (!value) return '';
  const normalized = path.normalize(value);
  return normalized === home ? '~' : normalized.startsWith(`${home}${path.sep}`)
    ? `~${normalized.slice(home.length)}` : normalized;
}

function firstString(input, keys) {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value != null && typeof value !== 'object') return String(value);
  }
  return '';
}

function mcpParts(name) {
  const marker = name.indexOf('__', 5);
  let server = marker < 0 ? name.slice(5) : name.slice(5, marker);
  const tool = marker < 0 ? name : name.slice(marker + 2);
  server = server.replace(/^plugin_/, '');
  const parts = server.split('_');
  if (parts.length % 2 === 0) {
    const half = parts.length / 2;
    if (parts.slice(0, half).join('_') === parts.slice(half).join('_')) server = parts.slice(0, half).join('_');
  }
  return { server, tool };
}

function webHost(value) {
  try { return new URL(value).host; } catch { return ''; }
}

function readInfo(tool, home) {
  const input = tool.input || {};
  if (tool.name === 'Read') {
    const file = firstString(input, ['file_path', 'path']);
    return {
      category: 'File', kind: 'file', name: path.basename(file),
      location: homePath(path.dirname(file), home)
    };
  }
  if (tool.name === 'Bash') {
    const command = firstString(input, ['command']);
    const shell = classifyShellCommand(command, {
      description: firstString(input, ['description']), home
    });
    if (shell.kind === 'run') {
      return {
        category: 'Run', kind: 'run',
        name: firstString(input, ['description']) || command.split('\n')[0].trim().slice(0, 60),
        location: command.split('\n')[0].trim().slice(0, 120)
      };
    }
    return {
      category: shell.kind === 'file' ? 'File' : 'Explore', kind: shell.kind,
      name: shell.name, location: shell.location, items: shell.items, sourceFiles: shell.files
    };
  }
  if (tool.name.startsWith('mcp__')) {
    const { server, tool: method } = mcpParts(tool.name);
    // An MCP call that changes something is not a read; its size is the text Claude sent.
    if (MCP_WRITE_VERB.test(method)) return null;
    return {
      category: 'MCP', kind: 'mcp',
      name: firstString(input, ['path', 'folder', 'words', 'query', 'url', 'file_path']) || method,
      location: `${server} · ${method}`
    };
  }
  if (tool.name === 'Skill') {
    return {
      category: 'Skill', kind: 'skill', name: firstString(input, ['skill']) || 'Skill',
      location: ''
    };
  }
  if (tool.name === 'WebFetch' || tool.name === 'WebSearch') {
    const name = firstString(input, ['url', 'query']);
    return { category: 'Web', kind: 'web', name, location: webHost(name) };
  }
  return null;
}

function savedOutputPath(text) {
  if (!/(?:Output too large|<persisted-output>)/i.test(text)) return '';
  return text.match(/Full output saved to:\s*([^\s<]+)/i)?.[1] || '';
}

function readLines(text) {
  const rawText = String(text).replaceAll('\r', '').trim();
  const rawLines = rawText.split('\n');
  const nonEmpty = rawLines.filter(line => line.trim());
  const prefixed = nonEmpty.filter(line => /^\s*\d+(?:\t|→)/.test(line)).length;
  const hasToolNumbers = nonEmpty.length > 0 && prefixed > nonEmpty.length / 2;
  const lineNumbers = [];
  const lines = rawLines.map((line, index) => {
    const match = hasToolNumbers ? line.match(/^\s*(\d+)(?:\t|→)/) : null;
    lineNumbers.push(match ? Number(match[1]) : index + 1);
    return match ? line.slice(match[0].length) : line;
  });
  return { text: lines.join('\n'), rawText, lineNumbers };
}

function isImageRead(tool, inputPath) {
  return tool.name === 'Read' && /\.(?:png|jpe?g|gif|webp|pdf)$/i.test(inputPath);
}

function distribute(events, growth) {
  if (!events.length) return;
  const totalChars = events.reduce((sum, event) => sum + Math.max(1, event.charCount), 0);
  const amount = Math.max(0, Math.round(growth));
  const shares = events.map((event, index) => {
    const exact = amount * Math.max(1, event.charCount) / totalChars;
    return { event, index, size: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remainder = amount - shares.reduce((sum, share) => sum + share.size, 0);
  for (const share of [...shares].sort((a, b) => b.fraction - a.fraction || a.index - b.index)) {
    if (remainder <= 0) break;
    share.size += 1;
    remainder -= 1;
  }
  for (const share of shares) {
    share.event.size = share.size;
    share.event.estimated = events.length > 1;
  }
}

function mergeSavedOutputs(reads) {
  const sources = new Map();
  for (const read of reads) if (read.savedPath) sources.set(path.normalize(read.savedPath), read);
  const removed = new Set();
  for (const read of reads) {
    if (!read.loadedPath) continue;
    const source = sources.get(path.normalize(read.loadedPath));
    if (!source || source === read) continue;
    source.text = read.text;
    source.rawText = read.rawText;
    source.shellOutput = read.text;
    source.size += read.size;
    source.estimated ||= read.estimated;
    source.charCount += read.charCount;
    source.toolUseIds = [...new Set([...(source.toolUseIds || []), ...(read.toolUseIds || [])])];
    removed.add(read);
  }
  return reads.filter(read => !removed.has(read)).map(read => {
    const parsed = readLines(read.rawText ?? read.text);
    const file = {
      name: read.name,
      path: read.loadedPath || read.location || read.name,
      text: read.text,
      rawText: parsed.rawText,
      lineNumbers: parsed.lineNumbers,
      size: read.size,
      toolUseIds: read.toolUseIds || []
    };
    const files = splitShellOutput(read, file);
    const { savedPath, loadedPath, charCount, sourceFiles, shellOutput, ...publicRead } = read;
    return { ...publicRead, files };
  });
}

const MAX_SPLIT_FILE_BYTES = 2 * 1024 * 1024;

function readSplitFile(filePath) {
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_SPLIT_FILE_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(descriptor, buffer, size, buffer.length - size, size);
      if (!count) return null;
      size += count;
    }
    if (fstatSync(descriptor).size !== size) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function textMatch(output, text, start) {
  const variants = [text];
  if (text.endsWith('\n')) variants.push(text.slice(0, -1));
  else variants.push(`${text}\n`);
  let found = null;
  for (const value of variants) {
    const index = output.indexOf(value, start);
    if (index >= 0 && (!found || index < found.index)) found = { index, value };
  }
  return found;
}

function exactShellParts(output, diskFiles) {
  let position = 0;
  let other = '';
  for (const file of diskFiles) {
    const match = textMatch(output, file.text, position);
    if (!match) return null;
    other += output.slice(position, match.index);
    position = match.index + match.value.length;
  }
  return { files: diskFiles, other: other + output.slice(position) };
}

function anchoredShellParts(output, diskFiles) {
  const lines = output.match(/[^\n]*\n|[^\n]+$/g) || [];
  const lineText = line => line.replace(/\r?\n$/, '');
  const diskLines = diskFiles.map(file => file.text.split(/\r?\n/).filter(line => line.trim()));
  const starts = [];
  let cursor = 0;
  for (const [anchor] of diskLines) {
    while (cursor < lines.length && lineText(lines[cursor]) !== anchor) cursor += 1;
    if (cursor === lines.length) return null;
    starts.push(cursor++);
  }
  cursor = starts.at(-1);
  let tailFound = true;
  for (const tail of diskLines.at(-1).slice(-3)) {
    while (cursor < lines.length && lineText(lines[cursor]) !== tail) cursor += 1;
    if (cursor === lines.length) {
      tailFound = false;
      break;
    }
    cursor += 1;
  }
  const files = diskFiles.map((file, index) => ({
    path: file.path,
    text: lines.slice(starts[index], starts[index + 1] ?? cursor).join('')
  }));
  const other = tailFound ? lines.slice(0, starts[0]).concat(lines.slice(cursor)).join('') : '';
  return { files, other };
}

function splitShellOutput(read, fallback) {
  const candidates = read.sourceFiles || [];
  if (candidates.length < 2 || candidates.some(file => file.revision || /[$*?\[\]{}]/.test(file.path))) return [fallback];
  const diskFiles = candidates.map(file => ({ path: file.path, text: readSplitFile(file.path) }));
  if (diskFiles.some(file => !file.text?.trim())) return [fallback];

  const output = read.shellOutput ?? fallback.rawText;
  const split = exactShellParts(output.replace(/\r?\n$/, ''), diskFiles) || anchoredShellParts(output, diskFiles);
  if (!split) return [fallback];
  const part = (name, filePath, text) => ({
    name,
    path: filePath,
    text,
    rawText: text,
    lineNumbers: text.split('\n').map((_, index) => index + 1),
    toolUseIds: fallback.toolUseIds
  });
  const parts = split.files.map(file => part(path.basename(file.path), file.path, file.text));
  if (split.other) parts.push(part('other output', 'other output', split.other));
  const total = parts.reduce((sum, part) => sum + Math.max(1, part.text.length), 0);
  let assigned = 0;
  parts.forEach((part, index) => {
    part.size = index === parts.length - 1
      ? fallback.size - assigned
      : Math.floor(fallback.size * Math.max(1, part.text.length) / total);
    assigned += part.size;
  });
  return parts;
}

function groupFiles(reads) {
  const result = [];
  for (let index = 0; index < reads.length;) {
    const first = reads[index];
    if (first.category !== 'File' || !first.location) {
      result.push(first);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < reads.length && reads[end].category === 'File' && reads[end].location === first.location) end += 1;
    const group = reads.slice(index, end);
    if (group.length === 1) {
      result.push(first);
    } else {
      const items = group.flatMap(read => read.items || [read.name]);
      result.push({
        ...first,
        name: `${items.length} files in ${first.location}`,
        items,
        size: group.reduce((sum, read) => sum + read.size, 0),
        text: group.map(read => read.text).join('\n\n'),
        files: group.flatMap(read => read.files),
        toolUseIds: group.flatMap(read => read.toolUseIds || []),
        estimated: group.some(read => read.estimated)
      });
    }
    index = end;
  }
  return result;
}

function toolPresentation(tool, result, source, home) {
  const info = readInfo(tool, home);
  const read = source?.read;
  const file = source?.file;
  const input = tool.input || {};
  const verb = tool.name.startsWith('mcp__') ? mcpParts(tool.name).tool.replaceAll('_', '.') : tool.name;
  const argument = firstString(input, ['file_path', 'path', 'command', 'query', 'url', 'description', 'skill'])
    || JSON.stringify(input);
  return {
    id: tool.id,
    ref: file?.ref || read?.ref || '',
    rowRef: read?.ref || '',
    kind: read?.kind || info?.kind || (tool.name.startsWith('mcp__') ? 'mcp' : 'run'),
    verb,
    argument: argument.slice(0, 240),
    input,
    result: result ? conversationText(result.content) : '',
    size: file?.size || read?.size || 0,
    isRead: Boolean(read)
  };
}

function buildConversation(records, reads, home) {
  const readByTool = new Map();
  for (const read of reads) {
    for (const file of read.files || []) {
      for (const id of file.toolUseIds || []) {
        const previous = readByTool.get(id);
        readByTool.set(id, previous && previous.file !== file ? { read } : { read, file });
      }
    }
  }
  const results = new Map();
  for (const record of records) {
    if (record.isSidechain === true || record.type !== 'user') continue;
    for (const block of blocksOf(record)) if (block?.type === 'tool_result') results.set(block.tool_use_id, block);
  }
  const items = [];
  let messageIndex = 0;
  for (const record of records) {
    if (record.isSidechain === true) continue;
    if (record.type === 'compact_boundary') {
      items.push({ type: 'compact' });
      continue;
    }
    if (record.type === 'user') {
      const text = blocksOf(record).filter(block => block?.type !== 'tool_result')
        .map(conversationText).map(value => value.trim()).filter(value => value
          && !/^<system-reminder>[\s\S]*<\/system-reminder>$/i.test(value)
          && !/^<(?:command-|local-command-)/i.test(value)
          && !/<command-(?:name|message|args)>/i.test(value)).join('\n\n');
      if (text) items.push({ type: 'message', role: 'user', text, messageIndex: messageIndex++ });
      continue;
    }
    if (record.type !== 'assistant') continue;
    const blocks = blocksOf(record);
    const text = blocks.filter(block => block?.type === 'text').map(conversationText).filter(Boolean).join('\n\n');
    const calls = blocks.filter(block => block?.type === 'tool_use' && block.id).map(block => {
      const tool = { id: block.id, name: block.name || '', input: block.input || {} };
      return toolPresentation(tool, results.get(block.id), readByTool.get(block.id), home);
    });
    if (text || calls.length) {
      items.push({ type: 'message', role: 'assistant', text, tools: calls, messageIndex: messageIndex++ });
    }
  }
  return items;
}

export function parseTranscript(source, options = {}) {
  if (!source.trim()) throw new Error('transcript is empty');
  const records = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch { throw new Error(`cannot read transcript line ${index + 1}`); }
  }
  if (!records.length) throw new Error('transcript is empty');

  const home = options.home || process.env.HOME || '';
  const tools = new Map();
  const toolUseSeen = new Set();
  const usageSeen = new Set();
  const reads = [];
  let pending = [];
  let previousTotal = null;
  let startLoadTokens = 0;
  let promptIndex = -1;
  const waitingSkills = [];

  const addRead = (tool, rawText, result = {}) => {
    const info = readInfo(tool, home);
    if (!info || EXCLUDED_TOOLS.has(tool.name)) return;
    const inputPath = tool.name === 'Read' ? firstString(tool.input, ['file_path', 'path']) : '';
    const image = isImageRead(tool, inputPath);
    const parsed = readLines(rawText);
    const text = image ? `[image: ${inputPath}]` : tool.name === 'Read' ? parsed.text : rawText.trim();
    const savedPath = savedOutputPath(rawText);
    const resultChars = rawText.length || JSON.stringify(result.content ?? '').length;
    const event = {
      ...info, tool: tool.name, size: 0, estimated: false, text, rawText: image ? text : parsed.rawText,
      promptIndex: tool.promptIndex, charCount: Math.max(1, resultChars),
      savedPath, loadedPath: inputPath, toolUseIds: [tool.id],
      // Relative paths in a command are relative to the session's folder, not to this process.
      ...(info.sourceFiles?.length > 1 ? {
        shellOutput: rawText,
        sourceFiles: info.sourceFiles.map(file => ({ ...file, path: path.resolve(tool.cwd || '/', file.path) }))
      } : {}),
      ...(info.kind === 'run' ? { discard: true } : {})
    };
    if (result.isError && !event.discard) return;
    reads.push(event);
    pending.push(event);
  };

  for (const record of records) {
    if (record.isSidechain === true) continue;
    if (record.type === 'assistant') {
      const messageId = record.message?.id || record.uuid;
      if (record.message?.usage && messageId && !usageSeen.has(messageId) && !isSyntheticAssistant(record)) {
        usageSeen.add(messageId);
        const currentTotal = totalUsage(record.message.usage);
        if (previousTotal == null) startLoadTokens = currentTotal;
        else distribute(pending, currentTotal - previousTotal);
        pending = [];
        previousTotal = currentTotal;
      }
      for (const block of blocksOf(record)) {
        if (block?.type !== 'tool_use' || !block.id || toolUseSeen.has(block.id)) continue;
        toolUseSeen.add(block.id);
        const tool = { id: block.id, name: block.name || '', input: block.input || {}, promptIndex, cwd: record.cwd || '' };
        tools.set(block.id, tool);
        if (tool.name === 'Skill') waitingSkills.push(tool);
      }
      continue;
    }
    if (record.type !== 'user') continue;
    const blocks = blocksOf(record);
    const plainText = blocks.filter(block => block?.type !== 'tool_result').map(textOf).filter(Boolean).join('\n');
    const skillBody = plainText.match(/(?:^|\n)(Base directory for this skill:[\s\S]*)/)?.[1];
    if (skillBody && waitingSkills.length) addRead(waitingSkills.shift(), skillBody);
    const hasUserPrompt = plainText.trim() && !skillBody && !/^<system-reminder>/i.test(plainText.trim());
    if (hasUserPrompt) promptIndex += 1;
    for (const block of blocks) {
      if (block?.type !== 'tool_result') continue;
      const tool = tools.get(block.tool_use_id);
      if (!tool || tool.name === 'Skill') continue;
      addRead(tool, textOf(block.content), { content: block.content, isError: block.is_error === true });
    }
  }

  const enteredReads = reads.filter(read => read.size != null && !pending.includes(read));
  const merged = groupFiles(mergeSavedOutputs(enteredReads).filter(read => !read.discard));
  merged.forEach((read, index) => {
    read.ref = `r${index}`;
    read.files.forEach((file, fileIndex) => {
      file.ref = read.files.length === 1 ? read.ref : `${read.ref}.${fileIndex + 1}`;
    });
  });
  const startLoad = buildStartLoad(records, startLoadTokens, { home });
  const cwd = records.find(record => record.cwd)?.cwd
    || records.find(record => record.type === 'attachment' && record.attachment?.type === 'environment')
      ?.attachment?.snapshot?.workingDirectory
    || '';
  return {
    sessionId: options.sessionId || '',
    cwd,
    startLoadTokens,
    startLoad,
    totalReadTokens: merged.reduce((sum, read) => sum + read.size, 0),
    reads: merged,
    conversation: buildConversation(records, merged, home)
  };
}
