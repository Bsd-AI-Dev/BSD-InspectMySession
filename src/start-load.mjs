import path from 'node:path';

export const START_ATTACHMENT_TYPES = new Map([
  ['skill_listing', 'skills'],
  ['mcp_instructions_delta', 'mcp'],
  ['deferred_tools_delta', 'deferred'],
  ['deferred_tools_record', 'deferred'],
  ['hook_additional_context', 'hooks']
]);

export const INSTRUCTION_HEADER = /(?:^|\n)Contents of (.+?) \([^\n]*\):\n\n/g;
export const SYSTEM_REMINDER = /^<system-reminder>[\s\S]*<\/system-reminder>\s*$/;
export const NON_PROMPT_BLOCK = /^<(?:local-command-caveat|command-name|command-message|command-args|local-command-stdout)[>\s]/;
export const OTHER_ATTACHMENT_LABELS = new Map([
  ['environment', 'environment'],
  ['model', 'model'],
  ['agent_listing_delta', 'agent listing'],
  ['auto_mode', 'permission mode'],
  ['session_context', 'session context'],
  ['date', 'date'],
  ['remote_session_change', 'git attribution'],
  ['total_tokens_reminder', 'token limit']
]);

const PART_ORDER = ['system', 'tools', 'instructions', 'skills', 'mcp', 'deferred', 'hooks', 'other', 'prompt', 'unrecorded'];

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.content != null) return textOf(value.content);
  }
  return '';
}

function renderedText(record) {
  return textOf(record.rendered).trim() || textOf(record.attachment?.content).trim();
}

function firstLine(value) {
  return String(value || '').trim().split('\n')[0];
}

function sentenceCase(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function displayPath(filePath, home, cwd) {
  const normalized = path.normalize(filePath);
  if (cwd && (normalized === cwd || normalized.startsWith(`${cwd}${path.sep}`))) {
    return path.join(path.basename(cwd), path.relative(cwd, normalized));
  }
  if (home && normalized === home) return '~';
  if (home && normalized.startsWith(`${home}${path.sep}`)) return `~${normalized.slice(home.length)}`;
  return normalized;
}

function mainRequest(records) {
  return records.find(record => record.type === 'api-request'
    && (!record.querySource || record.querySource === 'repl_main_thread'));
}

function requestMessages(records, request) {
  if (!request) return [];
  const blobs = new Map(records.filter(record => record.type === 'api-request-blob')
    .map(record => [record.hash, record.message]));
  return (request.tail || []).map(hash => blobs.get(hash)).filter(Boolean);
}

function userTextBlocks(messages) {
  const firstUser = messages.find(message => message?.role === 'user');
  const content = Array.isArray(firstUser?.content) ? firstUser.content : [{ text: textOf(firstUser?.content) }];
  return content.map(block => textOf(block)).filter(Boolean);
}

function instructionSections(text) {
  const matches = [...text.matchAll(INSTRUCTION_HEADER)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return {
      path: match[1].trim(),
      content: text.slice(start, end).replace(/\n<\/system-reminder>[\s\S]*$/, '').trim()
    };
  });
}

function firstPrompt(blocks, records) {
  const fromRequest = [...blocks].reverse().find(block => {
    const value = block.trim();
    return value && !SYSTEM_REMINDER.test(value) && !NON_PROMPT_BLOCK.test(value);
  });
  if (fromRequest) return fromRequest.trim();
  const direct = records.filter(record => record.type === 'user' && record.isSidechain !== true)
    .flatMap(record => Array.isArray(record.message?.content) ? record.message.content : [record.message?.content])
    .map(textOf).map(value => value.trim()).filter(value => value
      && !SYSTEM_REMINDER.test(value) && !NON_PROMPT_BLOCK.test(value) && !/<command-(?:name|message|args)>/.test(value));
  return direct.at(-1) || '';
}

function exactShares(entries, total) {
  if (!entries.length) return;
  const chars = entries.reduce((sum, entry) => sum + Math.max(1, entry.charCount), 0);
  for (const entry of entries) entry.size = Math.floor(total * Math.max(1, entry.charCount) / chars);
  const remainder = total - entries.reduce((sum, entry) => sum + entry.size, 0);
  const largest = entries.reduce((best, entry) => entry.charCount > best.charCount ? entry : best, entries[0]);
  largest.size += remainder;
}

function addPart(parts, key, name, detail, text, extra = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return;
  parts.push({ key, name, detail, text: cleanText, charCount: Math.max(1, cleanText.length), size: 0, ...extra });
}

export function buildStartLoad(records, total, options = {}) {
  const firstAssistant = records.findIndex(record => record.type === 'assistant' && record.isSidechain !== true);
  const initial = firstAssistant < 0 ? records : records.slice(0, firstAssistant);
  const home = options.home || process.env.HOME || '';
  const environment = initial.find(record => record.type === 'attachment' && record.attachment?.type === 'environment');
  const cwd = environment?.attachment?.snapshot?.workingDirectory || '';
  const request = mainRequest(initial);
  const messages = requestMessages(initial, request);
  const userBlocks = userTextBlocks(messages);
  const shape = initial.find(record => record.type === 'api-request-shape'
    && (!request?.shapeHash || record.shapeHash === request.shapeHash))?.shape;
  const promptSnapshot = initial.find(record => record.type === 'attachment'
    && record.attachment?.type === 'prompt_snapshot')?.attachment;
  const systemBlocks = shape?.system || promptSnapshot?.systemPrompt || [];
  const parts = [];

  const systemText = systemBlocks.map(textOf).filter(Boolean).join('\n\n');
  addPart(parts, 'system', 'System prompt', 'Claude Code base rules', systemText);

  if (shape?.tools?.length) {
    const toolNames = shape.tools.map(tool => tool.name || tool.definition?.name).filter(Boolean);
    const toolText = shape.tools.map(tool => {
      const name = tool.name || tool.definition?.name || 'Tool';
      const description = tool.description || tool.definition?.description || '';
      return `${name}: ${firstLine(description)}`.trimEnd();
    }).join('\n');
    const sample = toolNames.slice(0, 3).join(', ');
    // Show the short list, but weigh the size by the full definitions the model receives.
    addPart(parts, 'tools', 'Tools', `${toolNames.length} tools (${sample}${toolNames.length > 3 ? ', …' : ''})`, toolText,
      { charCount: JSON.stringify(shape.tools).length });
  }

  const reminderSections = userBlocks.flatMap(instructionSections);
  const instructionAttachment = initial.find(record => record.type === 'attachment'
    && record.attachment?.type === 'instructions')?.attachment;
  const sections = reminderSections.length ? reminderSections : (instructionAttachment?.files || []);
  if (sections.length) {
    const items = sections.map(section => ({
      name: displayPath(section.path, home, cwd), text: String(section.content || '').trim(), size: 0,
      charCount: Math.max(1, String(section.content || '').trim().length)
    }));
    addPart(parts, 'instructions', 'Instructions', `${items.length} files`,
      items.map(item => `${item.name}\n${item.text}`).join('\n\n'), { items });
  }

  const attachments = initial.filter(record => record.type === 'attachment');
  const skill = attachments.find(record => START_ATTACHMENT_TYPES.get(record.attachment?.type) === 'skills');
  if (skill) {
    const count = Number(skill.attachment.skillCount) || skill.attachment.names?.length || 0;
    addPart(parts, 'skills', 'Skills list', count ? `${count} skills` : '',
      skill.attachment.content || renderedText(skill));
  }

  const mcp = attachments.find(record => START_ATTACHMENT_TYPES.get(record.attachment?.type) === 'mcp');
  if (mcp) {
    const names = mcp.attachment.addedNames || [];
    addPart(parts, 'mcp', 'MCP instructions', names.length ? `${names.length} servers` : '',
      mcp.attachment.addedBlocks?.join('\n\n') || renderedText(mcp));
  }

  const deferred = attachments.filter(record => START_ATTACHMENT_TYPES.get(record.attachment?.type) === 'deferred');
  if (deferred.length) {
    const names = [...new Set(deferred.flatMap(record => record.attachment.addedNames || record.attachment.names || []))];
    const deferredText = deferred.flatMap(record => {
      const definitions = (record.attachment.surfacedDefinitions || []).map(item =>
        `${item.listing || item.name || ''}\n${JSON.stringify(item.definition || item, null, 2)}`.trim());
      return [renderedText(record), ...definitions];
    }).filter(Boolean).join('\n\n');
    addPart(parts, 'deferred', 'Deferred tools', names.length ? `${names.length} names` : '',
      deferredText || names.join('\n'));
  }

  const hooks = attachments.filter(record => START_ATTACHMENT_TYPES.get(record.attachment?.type) === 'hooks');
  const hookText = hooks.map(record => textOf(record.attachment.content).trim()).filter(Boolean).join('\n\n');
  addPart(parts, 'hooks', 'Hooks', firstLine(hookText), hookText);

  const otherAttachments = attachments.filter(record => OTHER_ATTACHMENT_LABELS.has(record.attachment?.type)
    && renderedText(record));
  const prompt = firstPrompt(userBlocks, initial);
  const otherUserBlocks = userBlocks.filter(block => block.trim() !== prompt
    && !SYSTEM_REMINDER.test(block.trim())).map(block => block.trim()).filter(Boolean);
  const otherText = [...otherAttachments.map(renderedText), ...otherUserBlocks].filter(Boolean).join('\n\n');
  const otherLabels = [...new Set(otherAttachments.map(record => OTHER_ATTACHMENT_LABELS.get(record.attachment.type)))];
  if (otherUserBlocks.length) otherLabels.push('local command context');
  addPart(parts, 'other', 'Other', otherLabels.map(sentenceCase).join(', '), otherText);
  addPart(parts, 'prompt', 'Your first message', '', prompt);

  if (!shape?.system || !shape?.tools) {
    addPart(parts, 'unrecorded', 'Not recorded in this session file', 'Older session format',
      'The session file does not record all content from the first request.');
  }

  parts.sort((a, b) => PART_ORDER.indexOf(a.key) - PART_ORDER.indexOf(b.key));
  exactShares(parts, Math.max(0, Math.round(total)));
  const instructions = parts.find(part => part.key === 'instructions');
  if (instructions?.items?.length) exactShares(instructions.items, instructions.size);
  for (const part of parts) {
    part.ref = `s-${part.key}`;
    delete part.charCount;
    for (const [index, item] of (part.items || []).entries()) {
      item.ref = `s-${part.key}-${index}`;
      delete item.charCount;
    }
  }
  return { total: Math.max(0, Math.round(total)), parts };
}
