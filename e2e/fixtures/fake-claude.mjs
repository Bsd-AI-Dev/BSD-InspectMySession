#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';

const log = process.env.SHOW_CONTEXT_FAKE_LOG;
if (log) await appendFile(log, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\n`);
if (process.env.SHOW_CONTEXT_FAKE_WAIT_MS) {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.SHOW_CONTEXT_FAKE_WAIT_MS)));
}
let prompt = process.argv.at(-1) || '';
if (prompt === '-' || !prompt) prompt = await readFile(0, 'utf8');
if (log) await appendFile(log, `${JSON.stringify({ prompt })}\n`);
const answerFile = process.env.SHOW_CONTEXT_FAKE_ANSWER;
if (answerFile) {
  console.log(JSON.stringify({
    result: (await readFile(answerFile, 'utf8')).trim(),
    total_cost_usd: 0.0123,
    duration_ms: 1250
  }));
} else {
  const splitRef = prompt.includes('Tool use id: conversation-split')
    ? prompt.match(/^(r\d+\.\d+)\s+Bash\s+.*\/b\.md$/m)?.[1]
    : '';
  let citations = splitRef
    ? [{
        ref: splitRef,
        quote: 'A quote absent from the transcript',
        kind: 'copied',
        explanation: 'This quote should be marked as missing.'
      }, {
        ref: splitRef,
        quote: 'Beta cited line',
        kind: 'copied',
        explanation: 'The second Markdown file contains the cited line.'
      }]
    : [
        { ref: 'r0.1', quote: 'Alpha citation one', kind: 'copied', explanation: 'Alpha contains the first fact.' },
        { ref: 'r0.1', quote: 'Alpha citation two', kind: 'copied', explanation: 'Alpha contains the second fact.' },
        { ref: 'r0.2', quote: 'Beta citation line', kind: 'copied', explanation: 'Beta contains the third fact.' },
        { ref: 'r0', quote: 'Group citation line', kind: 'copied', explanation: 'The group resolves this to gamma.' },
        { ref: 'unknown', quote: 'Ignore this', kind: 'copied', explanation: 'Unknown ref.' }
      ];
  if (prompt.includes('"""Alpha source Second source"""')) {
    citations = [citations[3], citations[1], {
      ref: 's-instructions-0',
      quote: 'Follow the local guide.',
      kind: 'copied',
      explanation: 'The session loaded this instruction at the start.'
    }, citations[2], citations[0]];
  }
  console.log(JSON.stringify({
    result: JSON.stringify({
      summary: 'The answer used the local guide.',
      citations
    }),
    total_cost_usd: 0.0123,
    duration_ms: 1250
  }));
}
