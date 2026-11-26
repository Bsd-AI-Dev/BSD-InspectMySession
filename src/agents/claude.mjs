import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'claude';

// On Windows, Node cannot start the npm claude.cmd shim, so prefer the native installer's claude.exe.
function claudeBinary() {
  if (process.env.SHOW_CONTEXT_CLAUDE_BIN) return process.env.SHOW_CONTEXT_CLAUDE_BIN;
  if (process.platform === 'win32') {
    const native = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    if (existsSync(native)) return native;
  }
  return 'claude';
}

// Token use from Claude Code's JSON reply: the whole run, and the models that answered (largest cost first).
function tokenUse(value) {
  const usage = value.usage || {};
  const created = usage.cache_creation || {};
  const models = Object.entries(value.modelUsage || {})
    .map(([model, use]) => ({ model, costUsd: Number(use?.costUSD) || 0 }))
    .sort((a, b) => b.costUsd - a.costUsd);
  return {
    tokens: {
      input: Number(usage.input_tokens) || 0,
      cacheRead: Number(usage.cache_read_input_tokens) || 0,
      cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
      output: Number(usage.output_tokens) || 0
    },
    cacheTtl: Number(created.ephemeral_1h_input_tokens) > 0 ? '1h' : '5m',
    models
  };
}

export async function ask({ sessionId, cwd, prompt, signal, model = '' }) {
  const binary = claudeBinary();
  const args = [
    '--resume', sessionId,
    '--fork-session',
    '--no-session-persistence',
    '--print',
    '--output-format', 'json',
    '--tools', '',
    '--max-turns', '1',
    ...(model ? ['--model', model] : []),
    prompt
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: cwd || process.cwd(),
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The server has no console, so without this Windows opens a console window for claude.exe.
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      if (error.code === 'ENOENT') {
        reject(new Error(`Claude Code CLI was not found: ${binary}. Install Claude Code, or set SHOW_CONTEXT_CLAUDE_BIN `
          + 'to the full path of the claude program (claude.exe on Windows) and run bsd-ims again.'));
      }
      else reject(new Error(`Claude Code CLI failed: ${error.message}`));
    });
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Claude Code CLI exited with code ${code}: ${stderr.trim() || stdout.trim() || 'no details'}`));
        return;
      }
      try {
        const value = JSON.parse(stdout);
        resolve({
          result: String(value.result || ''),
          totalCostUsd: Number(value.total_cost_usd) || 0,
          durationMs: Number(value.duration_ms) || 0,
          ...tokenUse(value)
        });
      } catch {
        reject(new Error('Claude Code CLI returned invalid JSON.'));
      }
    });
  });
}
