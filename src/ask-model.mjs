// Which model answers "Where did this come from?". No AI: a cost estimate from the session's last request.
// A fork of the session resends the whole session. Anthropic's cache holds it for 5 minutes or 1 hour after
// the last request, and only for the same model, so the session's own model is cheap while the cache is warm
// and expensive once it has expired; Haiku 5.5 is always cheap but starts without the cache.
import { HAIKU, baseModel, labelOf, priceOf, rate } from './prices.mjs';

// Tokens a question adds on top of the session (question, instructions, read list) and a typical answer size.
const NEW_TOKENS = 3000;
const OUTPUT_TOKENS = 1000;
const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 };
const TTL_LABEL = { '5m': '5-minute', '1h': '1-hour' };

function isMainRequest(record) {
  return record?.type === 'assistant' && record.isSidechain !== true && record.isApiErrorMessage !== true
    && record.message?.model !== '<synthetic>' && record.message?.usage && typeof record.message.usage === 'object';
}

// The session's last main-thread request: when it ran, which model, how large the context was, and which
// cache lifetime Claude Code used (from usage.cache_creation, when the session file records it).
export function lastRequest(transcript) {
  let last = null;
  let ttl = '';
  for (const line of String(transcript).split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!isMainRequest(record)) continue;
    last = record;
    const created = record.message.usage.cache_creation;
    if (Number(created?.ephemeral_1h_input_tokens) > 0) ttl = '1h';
    else if (Number(created?.ephemeral_5m_input_tokens) > 0) ttl = '5m';
  }
  if (!last) return null;
  const usage = last.message.usage;
  const tokens = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']
    .reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
  return { time: Date.parse(last.timestamp) || 0, model: String(last.message.model || ''), tokens, ttl };
}

export function estimateUsd(model, contextTokens, warm, ttl) {
  const price = priceOf(model);
  const prompt = contextTokens + NEW_TOKENS;
  const input = warm
    ? contextTokens * rate(price, 'cacheRead', prompt) + NEW_TOKENS * rate(price, 'cacheWrite', prompt, ttl)
    : prompt * rate(price, 'cacheWrite', prompt, ttl);
  return (input + OUTPUT_TOKENS * rate(price, 'output', prompt)) / 1e6;
}

export function idleText(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.floor(hours / 24)} days`;
  return minutes % 60 && hours < 10 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

const usd = value => `$${value.toFixed(value < 0.1 ? 3 : 2)}`;

export function chooseModel({ settings, last, now = Date.now() }) {
  const sessionModel = last?.model || '';
  const result = (model, reason, extra = {}) => ({
    model, label: labelOf(model), sessionModel, sessionLabel: labelOf(sessionModel), reason,
    timeoutMinutes: settings.askTimeoutMinutes, ...extra
  });
  if (!['auto', 'session'].includes(settings.askModel)) {
    return result(settings.askModel, `Set in Settings: ${labelOf(settings.askModel)}`);
  }
  if (!sessionModel) return result('', 'The session model is not recorded: using your Claude Code default model');
  if (settings.askModel === 'session') return result(sessionModel, 'Set in Settings: the same model as the session');
  if (!last.time) return result(sessionModel, 'The time of the last request is not recorded: using the session model');

  const ttl = settings.cacheLifetime === 'detect' ? last.ttl || '5m' : settings.cacheLifetime;
  const idleMs = Math.max(0, now - last.time);
  const warm = idleMs < TTL_MS[ttl] - 60_000;
  const sessionModelUsd = estimateUsd(sessionModel, last.tokens, warm, ttl);
  const sameAsHaiku = baseModel(sessionModel) === HAIKU;
  const haikuUsd = sameAsHaiku ? sessionModelUsd : estimateUsd(HAIKU, last.tokens, false, ttl);
  const extra = { ttl, idleMs, warm, contextTokens: last.tokens, estimate: { sessionModelUsd, haikuUsd } };
  const state = warm
    ? `Session idle ${idleText(idleMs)}, cache is still warm (${TTL_LABEL[ttl]} cache)`
    : `Session idle ${idleText(idleMs)}, cache expired (${TTL_LABEL[ttl]} cache)`;
  const limit = settings.costLimitUsd;
  if (sameAsHaiku || sessionModelUsd <= limit) {
    return result(sessionModel, `${state}: about ${usd(sessionModelUsd)} with ${labelOf(sessionModel)}`
      + (warm ? '' : `, within your ${usd(limit)} limit`), extra);
  }
  return result(HAIKU, `${state}: about ${usd(sessionModelUsd)} with ${labelOf(sessionModel)} is over your `
    + `${usd(limit)} limit, about ${usd(haikuUsd)} with ${labelOf(HAIKU)}`, extra);
}

// The tokens of an answer split into parts, each priced with the model that answered.
export function costParts(tokens, model, ttl = '5m') {
  const price = priceOf(model);
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return [
    ['Read from cache', tokens.cacheRead, 'cacheRead'],
    ['Written to cache', tokens.cacheWrite, 'cacheWrite'],
    ['New input', tokens.input, 'input'],
    ['Output', tokens.output, 'output']
  ].map(([label, count, kind]) => ({ label, tokens: count, usd: (count * rate(price, kind, prompt, ttl)) / 1e6 }));
}
