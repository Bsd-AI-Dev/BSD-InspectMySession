import path from 'node:path';
import { classifyShellCommand } from './shell-kind.mjs';
import { buildStartLoad } from './start-load.mjs';

export const EXCLUDED_TOOLS = new Set([
  'Write', 'Edit', 'NotebookEdit', 'ToolSearch', 'AskUserQuestion', 'TaskOutput',
  'TaskStop', 'Agent', 'Task', 'ScheduleWakeup', 'Artifact'
]);

// MCP tool names (the part after the server) that start with one of these verbs change state.
export const MCP_WRITE_VERB = /^(write|edit|move|remove|delete|create|update|save|set|send|post|put|patch|apply|bind|batch|merge|resolve|mark|share|unshare|retire|restore|submit)(_|$)/i;

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
      name: shell.name, location: shell.location, items: shell.items
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

function cleanReadText(text) {
  return text.split('\n').map(line => line.replace(/^\s*\d+\t/, '')).join('\n').trim();
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
    source.size += read.size;
    source.estimated ||= read.estimated;
    source.charCount += read.charCount;
    removed.add(read);
  }
  return reads.filter(read => !removed.has(read)).map(read => {
    const { savedPath, loadedPath, charCount, ...publicRead } = read;
    return publicRead;
  });
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
        estimated: group.some(read => read.estimated)
      });
    }
    index = end;
  }
  return result;
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
    const text = image ? `[image: ${inputPath}]` : tool.name === 'Read' ? cleanReadText(rawText) : rawText.trim();
    const savedPath = savedOutputPath(rawText);
    const resultChars = rawText.length || JSON.stringify(result.content ?? '').length;
    const event = {
      ...info, tool: tool.name, size: 0, estimated: false, text,
      promptIndex: tool.promptIndex, charCount: Math.max(1, resultChars),
      savedPath, loadedPath: inputPath,
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
      if (record.message?.usage && messageId && !usageSeen.has(messageId)) {
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
        const tool = { id: block.id, name: block.name || '', input: block.input || {}, promptIndex };
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
  const startLoad = buildStartLoad(records, startLoadTokens, { home });
  return {
    sessionId: options.sessionId || '',
    startLoadTokens,
    startLoad,
    totalReadTokens: merged.reduce((sum, read) => sum + read.size, 0),
    reads: merged
  };
}
