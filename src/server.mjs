import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { agentFor } from './agents/index.mjs';
import { validateAskAnswer } from './ask-answer.mjs';
import { buildAskPrompt } from './ask-prompt.mjs';

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error('Request body is too large.');
  }
  return JSON.parse(body || '{}');
}

export async function startServer({ model, html }) {
  const token = randomBytes(32).toString('hex');
  const port = process.env.SHOW_CONTEXT_PORT ? Number(process.env.SHOW_CONTEXT_PORT) : 0;
  const idleMs = Number(process.env.SHOW_CONTEXT_IDLE_MS) || 30 * 60 * 1000;
  let busy = false;
  let timer;
  let origin = '';
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => server.close(), idleMs);
    timer.unref();
  };
  const server = http.createServer(async (request, response) => {
    touch();
    const requestUrl = new URL(request.url, origin || 'http://127.0.0.1');
    const root = `/${token}/`;
    if (!requestUrl.pathname.startsWith(root)) return send(response, 404, { error: 'Not found.' });
    if (request.method === 'GET' && requestUrl.pathname === root) {
      return send(response, 200, html, 'text/html; charset=utf-8');
    }
    if (request.method !== 'POST' || requestUrl.pathname !== `${root}ask`) {
      return send(response, 404, { error: 'Not found.' });
    }
    if (request.headers.origin !== origin) return send(response, 403, { error: 'Origin is not allowed.' });
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return send(response, 415, { error: 'Content-Type must be application/json.' });
    }
    if (busy) return send(response, 409, { error: 'An ask is already running.' });
    busy = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
      const body = await readJson(request);
      if (!['text', 'tool'].includes(body.kind) || typeof body.question !== 'string') {
        throw new Error('Ask request is invalid.');
      }
      const prompt = buildAskPrompt(model, body);
      const result = await agentFor().ask({
        sessionId: model.sessionId,
        cwd: model.cwd,
        prompt,
        signal: controller.signal
      });
      const answer = validateAskAnswer(result.result, model, {
        costUsd: result.totalCostUsd,
        durationMs: result.durationMs
      });
      send(response, 200, answer);
    } catch (error) {
      const message = error.name === 'AbortError'
        ? 'The fork timed out after 180 seconds.'
        : String(error.message || error);
      send(response, 500, { error: message });
    } finally {
      clearTimeout(timeout);
      busy = false;
      touch();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  touch();
  return { server, url: `${origin}/${token}/` };
}
