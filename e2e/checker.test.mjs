import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const checker = path.join(repo, 'contract/check-transcript.mjs');
const jsonLine = value => `${JSON.stringify(value)}\n`;

async function session(id, toolCalls) {
  const projects = await mkdtemp(path.join(os.tmpdir(), 'bsd-ims-checker-'));
  const dir = path.join(projects, 'fixture');
  await mkdir(dir, { recursive: true });
  const usage = n => ({ input_tokens: 10, cache_read_input_tokens: n, cache_creation_input_tokens: 0, output_tokens: 5 });
  const records = [{ type: 'user', isSidechain: false, cwd: '/tmp/project', message: { role: 'user', content: 'Check the repo.' } }];
  toolCalls.forEach(([name, input, output], index) => {
    records.push({
      type: 'assistant', isSidechain: false,
      message: { id: `a${index}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${index}`, name, input }], usage: usage(1000 + index * 100) }
    }, {
      type: 'user', isSidechain: false,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${index}`, content: output }] }
    });
  });
  records.push({
    type: 'assistant', isSidechain: false,
    message: { id: 'end', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: usage(2000) }
  });
  await writeFile(path.join(dir, `${id}.jsonl`), records.map(jsonLine).join(''));
  const run = spawnSync(process.execPath, [checker, id, '--projects', projects, '--no-cli', '--json'], { encoding: 'utf8' });
  return JSON.parse(run.stdout).sessions[0].findings.filter(finding => finding.id === 'parse-no-reads');
}

test('checker: short Bash commands without reads are an INFO note, not a warning', async () => {
  const [finding] = await session('cccccccc-1111-4111-8111-111111111111', [
    ['Bash', { command: 'mkdir -p dist', description: 'Make folder' }, ''],
    ['Bash', { command: 'npm test', description: 'Run tests' }, 'ok']
  ]);
  assert.equal(finding.level, 'INFO');
  assert.match(finding.message, /2 Bash calls/);
  assert.match(finding.message, /not counted as reads/);
});

test('checker: other tool calls that give no reads are still a warning', async () => {
  const [finding] = await session('cccccccc-2222-4222-8222-222222222222', [
    ['Skill', { skill: 'deploy' }, 'Launching skill: deploy']
  ]);
  assert.equal(finding?.level, 'WARN');
});
