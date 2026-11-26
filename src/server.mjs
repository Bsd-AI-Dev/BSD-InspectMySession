import { randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { agentFor } from './agents/index.mjs';
import { validateAskAnswer } from './ask-answer.mjs';
import { chooseModel, costParts, lastRequest } from './ask-model.mjs';
import { buildAskPrompt } from './ask-prompt.mjs';
import { askStore, isModelId, settingsError } from './ask-store.mjs';
import { renderMenuPage } from './menu-page.mjs';
import { PRICES, PRICES_UPDATED, labelOf } from './prices.mjs';
import { allSessions, sessionGroups, sessionMeta } from './sessions.mjs';
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
  // Settings and the ask log live next to server.json.
  const store = askStore(stateFile ? path.dirname(stateFile) : path.join(os.homedir(), '.cache/bsd-ims'));
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
  // The model choice is made from the session file as it is now, so a session used a minute ago counts as warm.
  const planFor = async (id, settings) => {
    const session = (await allSessions(root)).find(item => item.id === id);
    if (!session) return null;
    const last = lastRequest(await readFile(session.file, 'utf8'));
    const meta = await sessionMeta(session);
    const project = meta.cwd ? meta.cwd.split(/[\\/]/).filter(Boolean).pop() || '' : session.project;
    return { choice: chooseModel({ settings, last }), title: meta.title, project };
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
        if (route === 'api/settings') {
          return send(response, 200, { settings: await store.loadSettings(), prices: PRICES, pricesUpdated: PRICES_UPDATED });
        }
        if (route === 'api/asks') return send(response, 200, { asks: await store.readAsks() });
        const askModel = route.match(/^s\/([A-Za-z0-9-]+)\/ask-model$/);
        if (askModel) {
          const plan = await planFor(askModel[1], await store.loadSettings());
          return plan ? send(response, 200, plan.choice) : send(response, 404, { error: 'Session not found.' });
        }
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
      if (route !== 'stop' && route !== 'api/settings' && !askRoute) return send(response, 404, { error: 'Not found.' });
      if (request.headers.origin !== origin) return send(response, 403, { error: 'Origin is not allowed.' });
      if (route === 'stop') {
        send(response, 200, { ok: true });
        setImmediate(shutdown);
        return;
      }
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return send(response, 415, { error: 'Content-Type must be application/json.' });
      }
      if (route === 'api/settings') {
        const update = await readJson(request);
        const error = settingsError(update);
        if (error) return send(response, 400, { error });
        return send(response, 200, { settings: await store.saveSettings(update) });
      }
      // Ask about the page as it was loaded, so the read refs in the answer match what is on screen.
      const model = models.get(askRoute[1]) || await loadModel(askRoute[1]);
      if (!model) return send(response, 404, { error: 'Session not found.' });
      return await answer(request, response, model, askRoute[1]);
    } catch (error) {
      return send(response, 500, { error: String(error?.message || error) });
    }
  });

  async function answer(request, response, model, id) {
    if (busy) return send(response, 409, { error: 'An ask is already running.' });
    busy = true;
    const settings = await store.loadSettings();
    const started = Date.now();
    const controller = new AbortController();
    let cancelled = false;
    const timeout = setTimeout(() => controller.abort(), settings.askTimeoutMinutes * 60_000);
    // The page's Cancel button closes the request: stop Claude so the next ask can start.
    response.on('close', () => {
      if (response.writableFinished) return;
      cancelled = true;
      controller.abort();
    });
    let body = {};
    let plan = null;
    let choice = null;
    // Every ask goes to the ask log, written before the reply so the log is current when the page reads it.
    const log = fields => store.addAsk({
      time: new Date(started).toISOString(),
      sessionId: id,
      title: plan?.title || '',
      project: plan?.project || '',
      kind: body.kind || '',
      question: settings.keepQuestionText && typeof body.question === 'string' ? body.question : '',
      text: settings.keepQuestionText && typeof body.text === 'string' ? body.text.slice(0, 500) : '',
      choice,
      elapsedMs: Date.now() - started,
      ...fields
    }).catch(() => {});
    try {
      body = await readJson(request);
      if (!['text', 'tool'].includes(body.kind) || typeof body.question !== 'string') {
        throw new Error('Ask request is invalid.');
      }
      if (body.model !== undefined && !isModelId(body.model)) throw new Error('The model name is invalid.');
      plan = await planFor(id, settings);
      choice = plan?.choice || null;
      // "Try again with ..." on the page names the model itself.
      if (body.model) choice = { ...choice, model: body.model, label: labelOf(body.model), reason: `Asked again with ${labelOf(body.model)}` };
      const prompt = buildAskPrompt(model, body);
      const result = await agentFor().ask({
        sessionId: model.sessionId,
        cwd: model.cwd,
        prompt,
        signal: controller.signal,
        model: choice?.model || ''
      });
      const validated = validateAskAnswer(result.result, model, {
        costUsd: result.totalCostUsd,
        durationMs: result.durationMs
      });
      const used = result.models?.[0]?.model || choice?.model || '';
      const tokens = result.tokens || { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      const usage = { model: used, models: result.models || [], tokens, parts: costParts(tokens, used, result.cacheTtl) };
      await log({
        status: 'answered',
        costUsd: validated.costUsd,
        durationMs: validated.durationMs,
        found: validated.citations.filter(citation => citation.quoteFound).length,
        ...usage
      });
      send(response, 200, { ...validated, ...usage, choice });
    } catch (error) {
      const status = cancelled ? 'cancelled' : error.name === 'AbortError' ? 'timeout' : 'error';
      const message = status === 'timeout'
        ? `The fork timed out after ${settings.askTimeoutMinutes} minutes.`
        : status === 'cancelled' ? 'Cancelled.' : String(error.message || error);
      await log({ status, error: message });
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
