#!/usr/bin/env node
// check-transcript.mjs
// Checks that a real Claude Code transcript still matches what show-context expects
// (see transcript-contract.json), runs the real parser on it as a smoke test, and
// tells you what to search for and change if something drifted.
// Node built-ins only.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const HELP = `Check that a Claude Code transcript still matches show-context's expectations.

Usage: node check-transcript.mjs [session.jsonl | session-id-prefix] [options]

With no target, the newest session is checked.

Options:
  --latest N        Check the N newest sessions (default 1).
  --contract FILE   Contract file (default: transcript-contract.json next to this script).
  --src DIR         show-context src folder for the parser smoke test (default: ../src).
  --projects DIR    Claude projects folder (default: SHOW_CONTEXT_PROJECTS or ~/.claude/projects).
  --no-parse        Skip the parser smoke test.
  --no-cli          Skip the 'claude --help' flag check.
  --json            Print machine-readable results.
  --fix-prompt      Print a ready-to-paste prompt for Claude Code describing what to fix.
  --stamp           If there are no FAIL findings, record the Claude Code version(s) seen and the
                    unknown-but-reviewed items in the contract, so later runs only show NEW changes.
  -h, --help        Show this help.

Exit code: 0 = ok, 1 = warnings, 2 = failures.
`;

// ------------------------------------------------------------------ args

function parseArgs(argv) {
  const opts = { latest: 1, flags: new Set(), target: '' };
  const valueOptions = new Set(['--latest', '--contract', '--src', '--projects']);
  const flagOptions = new Set(['--no-parse', '--no-cli', '--json', '--fix-prompt', '--stamp', '-h', '--help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueOptions.has(a)) {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else if (flagOptions.has(a)) {
      opts.flags.add(a);
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option: ${a}`);
    } else if (!opts.target) {
      opts.target = a;
    } else {
      throw new Error('only one target allowed');
    }
  }
  opts.latest = Math.max(1, Number(opts.latest) || 1);
  return opts;
}

// ------------------------------------------------------------------ helpers

const LEVELS = { FAIL: 3, WARN: 2, INFO: 1, PASS: 0 };

function get(obj, spec) {
  for (const alt of spec.split('|')) {
    let v = obj;
    for (const key of alt.split('.')) {
      if (v == null) break;
      v = v[key];
    }
    if (v != null) return v;
  }
  return undefined;
}

function typeName(v) { return Array.isArray(v) ? 'array' : typeof v; }
function typeOk(v, expect) { return !expect || expect.split('|').includes(typeName(v)); }

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

function projectsRoot(opts) {
  return path.resolve(opts.projects || process.env.SHOW_CONTEXT_PROJECTS || path.join(os.homedir(), '.claude/projects'));
}

function listSessions(root) {
  const out = [];
  let projects = [];
  try { projects = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(root, p.name);
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, e.name);
      out.push({ file, id: e.name.slice(0, -6), project: p.name, mtimeMs: statSync(file).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function resolveTargets(opts) {
  if (opts.target && opts.target.endsWith('.jsonl') && existsSync(opts.target)) {
    const file = path.resolve(opts.target);
    return [{ file, id: path.basename(file, '.jsonl'), project: path.basename(path.dirname(file)) }];
  }
  const sessions = listSessions(projectsRoot(opts));
  if (!sessions.length) throw new Error(`no sessions found under ${projectsRoot(opts)}`);
  if (opts.target) {
    const matches = sessions.filter(s => s.id.startsWith(opts.target));
    if (!matches.length) throw new Error(`session not found: ${opts.target}`);
    if (matches.length > 1) throw new Error(`session prefix is ambiguous: ${matches.map(m => m.id).join(', ')}`);
    return matches;
  }
  return sessions.slice(0, opts.latest);
}

// ------------------------------------------------------------------ findings

function makeCollector() {
  const findings = [];
  let passed = 0;
  return {
    findings,
    pass() { passed++; },
    get passed() { return passed; },
    add(level, id, message, def = {}, extra = {}) {
      findings.push({
        level, id, message,
        effect: def.effect || '',
        usedBy: def.usedBy || [],
        search: def.search || [],
        action: def.action || '',
        ...extra
      });
    }
  };
}

function checkFields(c, label, items, fields, inherited = {}) {
  if (!items.length) return;
  for (const [spec, def] of Object.entries(fields || {})) {
    const merged = { usedBy: inherited.usedBy, ...def };
    const present = items.filter(x => get(x, spec) !== undefined);
    const ok = present.filter(x => typeOk(get(x, spec), def.type));
    if (ok.length === 0) {
      if (def.optional && present.length === 0) { c.pass(); continue; }
      const level = def.severity || 'WARN';
      const why = present.length
        ? `field "${spec}" exists in ${present.length} of ${items.length} ${label} but with an unexpected type (expected ${def.type}, saw ${[...new Set(present.map(x => typeName(get(x, spec))))].join('/')})`
        : `field "${spec}" is not present in any of the ${items.length} ${label}`;
      c.add(level, `field:${label}:${spec}`, why, merged);
      continue;
    }
    if (def.expectOneOf) {
      const values = present.map(x => get(x, spec));
      if (!values.some(v => def.expectOneOf.includes(v))) {
        c.add(def.severity || 'WARN', `value:${label}:${spec}`,
          `"${spec}" no longer has the expected value(s) ${JSON.stringify(def.expectOneOf)}; saw ${JSON.stringify([...new Set(values)].slice(0, 5))}`, merged);
        continue;
      }
    }
    c.pass();
  }
}

// ------------------------------------------------------------------ transcript checks

function slugOf(cwd, rule) {
  const abs = cwd;
  return rule === 'upstream'
    ? abs.replaceAll('/', '-').replaceAll('.', '-')
    : abs.replace(/[^a-zA-Z0-9]/g, '-');
}

async function checkTranscript(target, contract, opts) {
  const c = makeCollector();
  const unknown = { recordTypes: new Set(), attachmentTypes: new Set(), blockTypes: new Set(), toolNames: new Set() };
  const reviewed = contract.reviewed || {};
  const isReviewed = (kind, name) => (reviewed[kind] || []).includes(name);

  const source = readFileSync(target.file, 'utf8');
  const records = [];
  let badLines = 0;
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { badLines++; }
  }

  const stats = { file: target.file, id: target.id, records: records.length, versions: [], types: {} };
  for (const r of records) stats.types[r.type] = (stats.types[r.type] || 0) + 1;
  stats.versions = [...new Set(records.map(r => r.version).filter(v => typeof v === 'string'))];

  if (!records.length) {
    c.add('FAIL', 'transcript-empty', 'No readable records in this file.', { effect: 'show-context stops with "transcript is empty".' });
    return { stats, unknown, ...c };
  }
  if (badLines) {
    c.add('WARN', 'bad-lines', `${badLines} line(s) are not valid JSON (a session still being written can have a partial last line).`,
      { effect: 'show-context refuses the whole transcript if any line cannot be parsed.', search: ['cannot read transcript line'], usedBy: ['src/show-context.mjs:parseTranscript'] });
  } else c.pass();

  const main = records.filter(r => r.isSidechain !== true);

  // --- record types
  for (const [type, def] of Object.entries(contract.records || {})) {
    const items = (def.mainThreadOnly ? main : records).filter(r => r.type === type);
    if (!items.length) {
      if (def.required) c.add(def.missingSeverity || 'WARN', `record-missing:${type}`, `No "${type}" records in this transcript.`, def);
      continue;
    }
    c.pass();
    checkFields(c, `${type} records`, items, def.fields, def);
    for (const [arrSpec, itemFields] of Object.entries(def.itemChecks || {})) {
      const arrays = items.map(x => get(x, arrSpec)).filter(Array.isArray);
      const flat = arrays.flat().filter(x => x && typeof x === 'object');
      for (const [spec, idef] of Object.entries(itemFields)) {
        if (!flat.length) continue;
        const ok = flat.some(x => get(x, spec) !== undefined);
        if (ok) c.pass();
        else c.add(idef.severity || 'WARN', `item:${type}:${arrSpec}:${spec}`,
          `none of the ${flat.length} entries in "${arrSpec}" has "${spec}"`, { usedBy: def.usedBy, ...idef });
      }
    }
  }
  for (const type of Object.keys(stats.types)) {
    if (!(contract.records || {})[type] && !isReviewed('recordTypes', type)) unknown.recordTypes.add(type);
  }
  if (unknown.recordTypes.size) {
    c.add('INFO', 'unknown-record-types',
      `Record types the contract does not know: ${[...unknown.recordTypes].map(t => `${t} (${stats.types[t]})`).join(', ')}`,
      { effect: 'show-context ignores them. If one carries token usage, tool calls or session-start data, the page may be missing something.',
        action: 'Look at one example of each. If they do not matter, run with --stamp to mark them reviewed.' });
  }

  // --- content blocks
  const blocksByType = new Map();
  const toolUses = new Map();
  const toolResults = new Map();
  for (const r of main) {
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const list = blocksByType.get(b.type) || [];
      list.push(b);
      blocksByType.set(b.type, list);
      if (b.type === 'tool_use' && b.id) toolUses.set(b.id, b);
      if (b.type === 'tool_result' && b.tool_use_id) toolResults.set(b.tool_use_id, b);
    }
  }
  const known = contract.contentBlocks?.known || {};
  for (const [type, def] of Object.entries(known)) {
    const items = blocksByType.get(type) || [];
    if (!items.length) continue;
    c.pass();
    checkFields(c, `${type} blocks`, items, def.fields, contract.contentBlocks);
  }
  for (const type of blocksByType.keys()) {
    if (!known[type] && !isReviewed('blockTypes', String(type))) unknown.blockTypes.add(String(type));
  }
  if (unknown.blockTypes.size) {
    c.add('INFO', 'unknown-block-types',
      `Message block types the contract does not know: ${[...unknown.blockTypes].map(t => `${t} (${blocksByType.get(t).length})`).join(', ')}`,
      { effect: 'show-context only reads text, tool_use, tool_result and image blocks. Others are skipped.',
        action: 'Usually harmless (for example thinking blocks). Review once, then --stamp.', usedBy: ['src/show-context.mjs:blocksOf'] });
  }

  // --- attachments
  const attachments = main.filter(r => r.type === 'attachment' && r.attachment && typeof r.attachment === 'object');
  const knownAtt = contract.attachments?.known || {};
  for (const [type, def] of Object.entries(knownAtt)) {
    const items = attachments.filter(r => r.attachment.type === type).map(r => r.attachment);
    if (!items.length) continue;
    c.pass();
    checkFields(c, `${type} attachments`, items, def.fields, { usedBy: contract.attachments.usedBy });
  }
  const seenAtt = new Map();
  for (const r of attachments) seenAtt.set(r.attachment.type, (seenAtt.get(r.attachment.type) || 0) + 1);
  for (const [type, n] of seenAtt) {
    if (!knownAtt[type] && !isReviewed('attachmentTypes', String(type))) unknown.attachmentTypes.add(String(type));
  }
  if (unknown.attachmentTypes.size) {
    c.add('INFO', 'unknown-attachment-types',
      `Attachment types the contract does not know: ${[...unknown.attachmentTypes].map(t => `${t} (${seenAtt.get(t)})`).join(', ')}`,
      { effect: contract.attachments.effectIfNew, usedBy: contract.attachments.usedBy,
        search: ['START_ATTACHMENT_TYPES', 'OTHER_ATTACHMENT_LABELS'],
        action: 'Decide whether each new type belongs to Skills / MCP / Instructions / Other in buildStartLoad, then add it to the contract.' });
  }

  // --- tools
  const toolsDef = contract.tools || {};
  const counted = toolsDef.counted || {};
  const excluded = new Set(toolsDef.excluded || []);
  const gaps = toolsDef.knownGaps || {};
  const callsByName = new Map();
  for (const b of toolUses.values()) {
    const n = b.name || '(no name)';
    const list = callsByName.get(n) || [];
    list.push(b);
    callsByName.set(n, list);
  }
  for (const [name, def] of Object.entries(counted)) {
    const calls = callsByName.get(name) || [];
    if (!calls.length) continue;
    for (const spec of def.inputKeys || []) {
      const ok = calls.some(b => get(b.input || {}, spec) !== undefined);
      if (ok) c.pass();
      else c.add('WARN', `tool-input:${name}:${spec}`,
        `${calls.length} ${name} call(s) but none has input "${spec}"`,
        { effect: `${name} reads cannot be named or classified.`, usedBy: toolsDef.usedBy, search: def.search });
    }
  }
  for (const [name, def] of Object.entries(gaps)) {
    const calls = callsByName.get(name) || [];
    if (!calls.length) continue;
    const chars = calls.reduce((sum, b) => sum + textOf(toolResults.get(b.id)?.content).length, 0);
    c.add('INFO', `known-gap:${name}`,
      `${name}: ${calls.length} call(s), about ${chars.toLocaleString()} result characters (roughly ${Math.round(chars / 4).toLocaleString()} tokens) not counted as reads by show-context.`,
      { effect: def.note, usedBy: toolsDef.usedBy, search: def.search });
  }
  for (const name of callsByName.keys()) {
    const handled = counted[name] || excluded.has(name) || gaps[name] || name.startsWith(toolsDef.countedPrefix || 'mcp__');
    if (!handled && !isReviewed('toolNames', name)) unknown.toolNames.add(name);
  }
  if (unknown.toolNames.size) {
    const total = [...unknown.toolNames].reduce((s, n) => s + callsByName.get(n).length, 0);
    c.add('INFO', 'unknown-tools',
      `Tools not handled by show-context: ${[...unknown.toolNames].map(n => `${n} (${callsByName.get(n).length})`).join(', ')}`,
      { effect: toolsDef.effectIfNew, usedBy: toolsDef.usedBy, search: ['readInfo', 'EXCLUDED_TOOLS'],
        action: `${total} call(s) in this transcript. If any return large results, add handling in readInfo or list them as excluded.` });
  }

  // --- text markers
  const markers = contract.textMarkers || {};
  const readCalls = [...toolUses.values()].filter(b => b.name === 'Read');
  if (readCalls.length && markers.readLineNumbers) {
    const re = new RegExp(markers.readLineNumbers.regex);
    let numbered = 0, tested = 0;
    for (const b of readCalls) {
      const res = toolResults.get(b.id);
      if (!res || res.is_error) continue;
      const lines = textOf(res.content).split('\n').filter(l => l.trim());
      if (!lines.length) continue;
      tested++;
      if (lines.filter(l => re.test(l)).length > lines.length / 2) numbered++;
    }
    if (tested && !numbered) {
      c.add('WARN', 'marker:readLineNumbers', `None of ${tested} Read results has the expected "  12<tab>text" line-number format.`,
        { ...markers.readLineNumbers, usedBy: ['src/show-context.mjs:readLines'] });
    } else if (tested) c.pass();
  }
  const skillCalls = [...toolUses.values()].filter(b => b.name === 'Skill');
  if (skillCalls.length && markers.skillBody) {
    const re = new RegExp(markers.skillBody.regex);
    const found = main.some(r => r.type === 'user' && re.test(textOf(r.message?.content)));
    if (!found) c.add('WARN', 'marker:skillBody', `${skillCalls.length} Skill call(s) but the text "${markers.skillBody.regex}" never appears in a user record.`,
      { ...markers.skillBody, usedBy: ['src/show-context.mjs:parseTranscript'] });
    else c.pass();
  }
  if (markers.persistedOutput) {
    const re = new RegExp(markers.persistedOutput.regex, 'i');
    const pathRe = new RegExp(markers.persistedOutput.pathRegex, 'i');
    const big = [...toolResults.values()].map(r => textOf(r.content)).filter(t => re.test(t));
    if (big.length) {
      if (big.some(t => pathRe.test(t))) c.pass();
      else c.add('WARN', 'marker:persistedOutput', `${big.length} large-output notice(s) found but none says where the output was saved.`,
        { ...markers.persistedOutput, usedBy: ['src/show-context.mjs:savedOutputPath'] });
    }
  }

  // --- version
  const verified = contract.verifiedWith || [];
  const verifiedVersions = new Set(verified.flatMap(v => v.claudeCode || []));
  if (!stats.versions.length) {
    c.add('INFO', 'version-unknown', 'Records carry no "version" field, so the Claude Code version cannot be compared with the verified list.', {});
  } else {
    const fresh = stats.versions.filter(v => !verifiedVersions.has(v));
    if (fresh.length) {
      c.add('INFO', 'version-new', `Claude Code version(s) not yet verified against this contract: ${fresh.join(', ')}`,
        { effect: 'Not an error. It means nothing has confirmed this version works with the parser yet.',
          action: verified.length ? 'If the rest of this report is clean, run with --stamp.' : 'No version has been stamped yet. After reviewing this report, run with --stamp.' });
    } else c.pass();
  }

  // --- storage: does the project folder name match the slug rules?
  const cwd = records.find(r => typeof r.cwd === 'string')?.cwd;
  if (cwd && contract.storage) {
    const rules = contract.storage.slugRules;
    const proposed = slugOf(cwd, 'proposed');
    const upstream = slugOf(cwd, 'upstream');
    // Compare ignoring case: on Windows the drive letter may be stored lowercase (c--projects-x).
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    // bsd-ims uses the "proposed" rule, so a folder that matches it is fine.
    const inUse = String(rules.inUse || '').startsWith('proposed') ? proposed : upstream;
    if (same(target.project, inUse) || same(target.project, upstream)) c.pass();
    else if (same(target.project, proposed)) {
      c.add('INFO', 'storage:slug', `Project folder "${target.project}" matches the "proposed" rule (${rules.proposed}) but not upstream's rule (${rules.upstream}).`,
        { effect: 'Expected on Windows with the unmodified upstream code: "guess the session for this folder" fails. Giving a session id works.',
          usedBy: contract.storage.usedBy, search: contract.storage.search });
    } else {
      c.add('WARN', 'storage:slug', `Project folder "${target.project}" matches neither slug rule for cwd "${cwd}".`,
        { effect: contract.storage.effect, usedBy: contract.storage.usedBy, search: contract.storage.search,
          action: 'Claude Code may have changed how project folders are named. Compare a few folder names with their cwd and update the rule in selectSession.' });
    }
  }

  // --- parser smoke test
  if (!opts.flags.has('--no-parse')) await smokeTest(source, main, stats, opts, c, contract);

  return { stats, unknown, ...c };
}

async function smokeTest(source, main, stats, opts, c) {
  const srcDir = path.resolve(opts.src || path.join(here, '..', 'src'));
  const entry = path.join(srcDir, 'show-context.mjs');
  if (!existsSync(entry)) {
    c.add('INFO', 'parse-skipped', `Parser not found at ${entry}; smoke test skipped. Use --src to point at the src folder.`, {});
    return;
  }
  let mod;
  try { mod = await import(pathToFileURL(entry).href); }
  catch (e) { c.add('FAIL', 'parse-import', `Could not load the parser: ${e.message}`, {}); return; }
  let model;
  try { model = mod.parseTranscript(source, { sessionId: 'check', home: os.homedir() }); }
  catch (e) {
    c.add('FAIL', 'parse-throws', `parseTranscript threw: ${e.message}`,
      { effect: 'The page cannot be built for this transcript.', usedBy: ['src/show-context.mjs:parseTranscript'], search: ['parseTranscript'] });
    return;
  }
  const withUsage = main.filter(r => r.type === 'assistant' && r.message?.usage).length;
  if (withUsage && !model.startLoadTokens) {
    c.add('FAIL', 'parse-no-start-tokens', `${withUsage} assistant records carry usage but startLoadTokens is 0.`,
      { effect: 'All token sizes are wrong.', usedBy: ['src/show-context.mjs:totalUsage'], search: ['totalUsage', 'startLoadTokens'] });
  } else c.pass();

  const keys = (model.startLoad?.parts || []).map(p => p.key);
  const hasRequests = Boolean(stats.types['api-request-shape']);
  if (hasRequests) {
    for (const k of ['system', 'tools']) {
      if (!keys.includes(k)) c.add('WARN', `parse-part:${k}`, `Start-load has no "${k}" part although api-request-shape records exist.`,
        { usedBy: ['src/start-load.mjs:buildStartLoad'], search: ['shape?.tools', 'shape?.system', 'api-request-shape'] });
      else c.pass();
    }
  }
  if (keys.includes('unrecorded')) {
    c.add('WARN', 'parse-unrecorded', 'Start-load reports "Not recorded in this session file" (system prompt or tools missing from the transcript).',
      { effect: 'The start-up breakdown is incomplete for this session.', usedBy: ['src/start-load.mjs:buildStartLoad'], search: ['unrecorded', 'api-request-shape'] });
  }
  const sum = (model.startLoad?.parts || []).reduce((s, p) => s + p.size, 0);
  if (model.startLoad && sum !== model.startLoad.total) {
    c.add('WARN', 'parse-sum', `Start-load parts add up to ${sum}, not ${model.startLoad.total}.`, { usedBy: ['src/start-load.mjs:exactShares'], search: ['exactShares'] });
  } else c.pass();

  const countedNames = main.flatMap(r => (r.type === 'assistant' && Array.isArray(r.message?.content)) ? r.message.content : [])
    .filter(b => b?.type === 'tool_use' && ['Read', 'Bash', 'Skill', 'WebFetch', 'WebSearch'].includes(b.name)).map(b => b.name);
  const countedCalls = countedNames.length;
  if (countedCalls && !model.reads.length && countedNames.every(name => name === 'Bash')) {
    // Commands that only run something (git status, npm test) and small outputs are not reads by design.
    c.add('INFO', 'parse-no-reads', `${countedCalls} Bash calls and 0 reads: commands that only run something, and small outputs, are not counted as reads.`,
      { effect: 'Expected when the session only ran commands. If one of them read a file, its program may be missing from the shell lists.', usedBy: ['src/shell-kind.mjs:classifyShellCommand'], search: ['classifyShellCommand', 'FILE_PROGRAMS'] });
  } else if (countedCalls && !model.reads.length) {
    c.add('WARN', 'parse-no-reads', `${countedCalls} Read/Bash/Skill/Web tool calls but the parser found 0 reads.`,
      { effect: 'The reads list is empty.', usedBy: ['src/show-context.mjs:parseTranscript'], search: ['addRead', 'readInfo'] });
  } else c.pass();

  const turns = main.filter(r => r.type === 'user' || r.type === 'assistant').length;
  if (turns && !model.conversation.length) {
    c.add('FAIL', 'parse-no-conversation', 'The conversation view is empty although the transcript has messages.',
      { usedBy: ['src/show-context.mjs:buildConversation'], search: ['buildConversation'] });
  } else c.pass();
  stats.parsed = { reads: model.reads.length, totalReadTokens: model.totalReadTokens, startLoadTokens: model.startLoadTokens, parts: keys };
}

// ------------------------------------------------------------------ CLI flag check

function checkCli(contract, opts) {
  const c = makeCollector();
  const def = contract.cli;
  if (!def) return c;
  const bin = process.env[def.binaryEnvVar] || 'claude';
  const res = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (res.error || res.status !== 0) {
    c.add('INFO', 'cli-unavailable', `Could not run "${bin} --help" (${res.error ? res.error.message : 'exit ' + res.status}); flag check skipped.`,
      { effect: def.effect, usedBy: def.usedBy });
    return c;
  }
  const help = `${res.stdout}\n${res.stderr}`;
  for (const f of def.flags) {
    if (help.includes(f.flag)) c.pass();
    else c.add(f.severity || 'INFO', `cli-flag:${f.flag}`,
      f.severity === 'INFO'
        ? `"${f.flag}" is not listed in "claude --help" (it may be hidden; verify with a real ask).`
        : `"${f.flag}" is not listed in "claude --help".`,
      { effect: def.effect, usedBy: def.usedBy, search: def.search });
  }
  return c;
}

// ------------------------------------------------------------------ output

function useColor() { return process.stdout.isTTY && !process.env.NO_COLOR; }
function paint(level, text) {
  if (!useColor()) return text;
  const code = { FAIL: 31, WARN: 33, INFO: 36, PASS: 32 }[level];
  return `\x1b[${code}m${text}\x1b[0m`;
}

function printFinding(f, indent = '') {
  console.log(`${indent}${paint(f.level, `[${f.level}]`)} ${f.message}`);
  if (f.effect) console.log(`${indent}       why it matters: ${f.effect}`);
  if (f.usedBy?.length) console.log(`${indent}       code:           ${f.usedBy.join(', ')}`);
  if (f.search?.length) console.log(`${indent}       search for:     ${f.search.join('  |  ')}`);
  if (f.action) console.log(`${indent}       what to do:     ${f.action}`);
}

function summarize(findings) {
  const n = { FAIL: 0, WARN: 0, INFO: 0 };
  for (const f of findings) n[f.level]++;
  return n;
}

function buildFixPrompt(results, cliFindings, contractPath) {
  const problems = [...results.flatMap(r => r.findings.map(f => ({ ...f, session: r.stats.id.slice(0, 8) }))), ...cliFindings]
    .filter(f => f.level === 'FAIL' || f.level === 'WARN')
    .sort((a, b) => LEVELS[b.level] - LEVELS[a.level]);
  const seen = new Set();
  const unique = problems.filter(f => (seen.has(f.id) ? false : seen.add(f.id)));
  const versions = [...new Set(results.flatMap(r => r.stats.versions))];
  const lines = [];
  lines.push('# Task: the Claude Code transcript format seems to have changed; update the parser');
  lines.push('');
  lines.push(`A format check (${path.basename(contractPath)} + check-transcript.mjs) found problems when comparing real transcripts with what this project expects.`);
  if (versions.length) lines.push(`Claude Code version(s) in the checked transcripts: ${versions.join(', ')}.`);
  lines.push('');
  lines.push('## Findings');
  unique.forEach((f, i) => {
    lines.push(`${i + 1}. **${f.level}** ${f.message}`);
    if (f.effect) lines.push(`   - Effect: ${f.effect}`);
    if (f.usedBy?.length) lines.push(`   - Code: ${f.usedBy.join(', ')}`);
    if (f.search?.length) lines.push(`   - Search for: ${f.search.map(s => '`' + s + '`').join(', ')}`);
    if (f.action) lines.push(`   - Hint: ${f.action}`);
  });
  if (!unique.length) lines.push('(No FAIL or WARN findings. Nothing to fix.)');
  lines.push('');
  lines.push('## How to proceed');
  lines.push('1. Look at the real records involved (print one example of each affected record type from a transcript; do not paste private message text anywhere public).');
  lines.push('2. Find the cause: did a field move, get renamed, or change type, or is it new data? Check the "Code" and "Search for" items above.');
  lines.push('3. Follow the project rules: Node built-ins only, no new dependencies, write or update the end-to-end test and fixture FIRST, smallest possible change, run `npm test`.');
  lines.push(`4. Update \`${path.basename(contractPath)}\` so it describes the new format, then re-run \`node check-transcript.mjs --latest 5\`.`);
  lines.push('5. Report what changed and what you could not verify. Do not push or publish.');
  return lines.join('\n');
}

// ------------------------------------------------------------------ main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.flags.has('-h') || opts.flags.has('--help')) { console.log(HELP); return 0; }

  const contractPath = path.resolve(opts.contract || path.join(here, 'transcript-contract.json'));
  let contract;
  try { contract = JSON.parse(readFileSync(contractPath, 'utf8')); }
  catch (e) { throw new Error(`cannot read contract ${contractPath}: ${e.message}`); }

  const targets = resolveTargets(opts);
  const results = [];
  for (const t of targets) results.push(await checkTranscript(t, contract, opts));
  const cli = opts.flags.has('--no-cli') ? makeCollector() : checkCli(contract, opts);

  const all = [...results.flatMap(r => r.findings), ...cli.findings];
  const counts = summarize(all);
  const passed = results.reduce((s, r) => s + r.passed, 0) + cli.passed;

  if (opts.flags.has('--json')) {
    console.log(JSON.stringify({
      contract: contractPath,
      sessions: results.map(r => ({ ...r.stats, findings: r.findings, passed: r.passed })),
      cli: { findings: cli.findings, passed: cli.passed },
      summary: { ...counts, passed }
    }, null, 2));
  } else if (opts.flags.has('--fix-prompt')) {
    console.log(buildFixPrompt(results, cli.findings, contractPath));
  } else {
    const verified = (contract.verifiedWith || []).flatMap(v => v.claudeCode || []);
    console.log(`Contract: ${contractPath}`);
    console.log(`Verified with Claude Code: ${verified.length ? [...new Set(verified)].join(', ') : '(nothing stamped yet)'}`);
    for (const r of results) {
      console.log('');
      console.log(`Session ${r.stats.id}  (${r.stats.records} records; Claude Code ${r.stats.versions.join(', ') || 'version not recorded'})`);
      if (r.stats.parsed) console.log(`  parser: ${r.stats.parsed.reads} reads, ${r.stats.parsed.totalReadTokens} read tokens, start load ${r.stats.parsed.startLoadTokens} tokens, parts: ${r.stats.parsed.parts.join(', ')}`);
      const sorted = [...r.findings].sort((a, b) => LEVELS[b.level] - LEVELS[a.level]);
      if (!sorted.length) console.log(`  ${paint('PASS', '[PASS]')} nothing to report (${r.passed} checks passed)`);
      for (const f of sorted) printFinding(f, '  ');
    }
    if (!opts.flags.has('--no-cli') && contract.cli) {
      console.log('');
      console.log('Claude CLI flags used by the ask feature');
      if (!cli.findings.length) console.log(`  ${paint('PASS', '[PASS]')} all flags listed in "claude --help"`);
      for (const f of cli.findings) printFinding(f, '  ');
    }
    console.log('');
    console.log(`Summary: ${counts.FAIL} FAIL, ${counts.WARN} WARN, ${counts.INFO} INFO, ${passed} checks passed`);
    if (counts.FAIL) console.log('Run again with --fix-prompt to get a prompt you can paste into Claude Code.');
    else if (counts.WARN) console.log('Run again with --fix-prompt to get a prompt you can paste into Claude Code.');
  }

  if (opts.flags.has('--stamp')) {
    if (counts.FAIL) {
      console.error('Not stamping: there are FAIL findings.');
    } else {
      const versions = [...new Set(results.flatMap(r => r.stats.versions))];
      contract.verifiedWith = contract.verifiedWith || [];
      contract.verifiedWith.push({ date: new Date().toISOString().slice(0, 10), claudeCode: versions, sessionsChecked: results.length });
      contract.reviewed = contract.reviewed || { recordTypes: [], attachmentTypes: [], blockTypes: [], toolNames: [] };
      for (const key of ['recordTypes', 'attachmentTypes', 'blockTypes', 'toolNames']) {
        const set = new Set(contract.reviewed[key] || []);
        for (const r of results) for (const name of r.unknown[key]) set.add(name);
        contract.reviewed[key] = [...set].sort();
      }
      writeFileSync(contractPath, JSON.stringify(contract, null, 2) + '\n');
      console.error(`Stamped ${contractPath} (Claude Code ${versions.join(', ') || 'version not recorded'}).`);
    }
  }

  return counts.FAIL ? 2 : counts.WARN ? 1 : 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`check-transcript: ${error.message}`);
  process.exitCode = 2;
});
