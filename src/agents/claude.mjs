import { spawn } from 'node:child_process';

export const name = 'claude';

export async function ask({ sessionId, cwd, prompt, signal }) {
  const binary = process.env.SHOW_CONTEXT_CLAUDE_BIN || 'claude';
  const args = [
    '--resume', sessionId,
    '--fork-session',
    '--no-session-persistence',
    '--print',
    '--output-format', 'json',
    '--tools', '',
    '--max-turns', '1',
    prompt
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: cwd || process.cwd(), signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      if (error.code === 'ENOENT') reject(new Error(`Claude Code CLI was not found: ${binary}`));
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
          durationMs: Number(value.duration_ms) || 0
        });
      } catch {
        reject(new Error('Claude Code CLI returned invalid JSON.'));
      }
    });
  });
}
