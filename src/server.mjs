import { randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { agentFor } from './agents/index.mjs';
import { validateAskAnswer } from './ask-answer.mjs';
import { buildAskPrompt } from './ask-prompt.mjs';
import { renderMenuPage } from './menu-page.mjs';
import { allSessions, sessionGroups } from './sessions.mjs';
import { parseTranscript } from './show-context.mjs';
import { renderShowContextPage } from './show-context-page.mjs';

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

// One local server for every session: the menu, each session page, and its ask route.
export async function startServer({ root, key = '', version = '', stateFile = '' }) {
  const token = randomBytes(32).toString('hex');
  const port = process.env.SHOW_CONTEXT_PORT ? Number(process.env.SHOW_CONTEXT_PORT) : 0;
  const idleMs = Number(process.env.SHOW_CONTEXT_IDLE_MS) || 60 * 60 * 1000;
  const models = new Map();
  let busy = false;
  let timer;
  let origin = '';
  let url = '';

  const shutdown = async () => {
    clearTimeout(timer);
    if (stateFile) {
      try {
        const state = JSON.parse(await readFile(stateFile, 'utf8'));
        if (state.url === url) await unlink(stateFile);
      } catch {}
    }
    server.close();
    server.closeAllConnections();
  };
  const touch = () => {
    clearTimeout(timer);
    // Never stop in the middle of an ask; look again after another idle period.
    timer = setTimeout(() => (busy ? touch() : shutdown()), idleMs);
    timer.unref();
  };
  const loadModel = async id => {
    const session = (await allSessions(root)).find(item => item.id === id);
    if (!session) return null;
    const model = parseTranscript(await readFile(session.file, 'utf8'), { sessionId: id, home: os.homedir() });
    models.set(id, model);
    return model;
  };

  const server = http.createServer(async (request, response) => {
    touch();
    const requestUrl = new URL(request.url, origin || 'http://127.0.0.1');
    const base = `/${token}/`;
    if (!requestUrl.pathname.startsWith(base)) return send(response, 404, { error: 'Not found.' });
    const route = requestUrl.pathname.slice(base.length);
    try {
      if (request.method === 'GET') {
        if (route === '') return send(response, 200, renderMenuPage({ version }), 'text/html; charset=utf-8');
        if (route === 'api/ping') return send(response, 200, { ok: true, key, version });
        if (route === 'api/sessions') return send(response, 200, { version, projects: await sessionGroups(root) });
        const page = route.match(/^s\/([A-Za-z0-9-]+)\/$/);
        if (page) {
          const model = await loadModel(page[1]);
          if (!model) return send(response, 404, { error: 'Session not found.' });
          return send(response, 200, renderShowContextPage(model, { live: true }), 'text/html; charset=utf-8');
        }
        return send(response, 404, { error: 'Not found.' });
      }
      if (request.method !== 'POST') return send(response, 404, { error: 'Not found.' });
      const askRoute = route.match(/^s\/([A-Za-z0-9-]+)\/ask$/);
      if (route !== 'stop' && !askRoute) return send(response, 404, { error: 'Not found.' });
      if (request.headers.origin !== origin) return send(response, 403, { error: 'Origin is not allowed.' });
      if (route === 'stop') {
        send(response, 200, { ok: true });
        setImmediate(shutdown);
        return;
      }
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return send(response, 415, { error: 'Content-Type must be application/json.' });
      }
      // Ask about the page as it was loaded, so the read refs in the answer match what is on screen.
      const model = models.get(askRoute[1]) || await loadModel(askRoute[1]);
      if (!model) return send(response, 404, { error: 'Session not found.' });
      return await answer(request, response, model);
    } catch (error) {
      return send(response, 500, { error: String(error?.message || error) });
    }
  });

  async function answer(request, response, model) {
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
      const validated = validateAskAnswer(result.result, model, {
        costUsd: result.totalCostUsd,
        durationMs: result.durationMs
      });
      send(response, 200, validated);
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
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  url = `${origin}/${token}/`;
  touch();
  return { server, url };
}
