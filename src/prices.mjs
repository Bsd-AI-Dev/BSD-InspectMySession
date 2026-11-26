// Claude API prices in US dollars per million tokens, used to estimate and explain the cost of a question.
// Claude Code reports the real total itself; these prices only split it into parts and compare models.
// Writing to the cache costs 1.25x the input price for the 5-minute cache and 2x for the 1-hour cache.
export const PRICES_UPDATED = '2026-11-03';

export const PRICES = [
  { model: 'claude-fable-5-2', label: 'Fable 5.2', input: 8, cacheRead: 0.2, output: 40 },
  { model: 'claude-fable-5-1', label: 'Fable 5.1', input: 10, cacheRead: 1, output: 50 },
  { model: 'claude-fable-5', label: 'Fable 5', input: 10, cacheRead: 1, output: 50 },
  { model: 'claude-opus-5-5', label: 'Opus 5.5', input: 4, cacheRead: 0.2, output: 20 },
  { model: 'claude-opus-5', label: 'Opus 5', input: 5, cacheRead: 0.5, output: 25 },
  { model: 'claude-opus-4-8', label: 'Opus 4.8', input: 5, cacheRead: 0.5, output: 25 },
  { model: 'claude-opus-4-7', label: 'Opus 4.7', input: 5, cacheRead: 0.5, output: 25 },
  { model: 'claude-opus-4-6', label: 'Opus 4.6', input: 5, cacheRead: 0.5, output: 25 },
  { model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', input: 2, cacheRead: 0.1, output: 10 },
  { model: 'claude-sonnet-5', label: 'Sonnet 5', input: 2, cacheRead: 0.2, output: 10 },
  { model: 'claude-sonnet-4-6', label: 'Sonnet 4.6', input: 3, cacheRead: 0.3, output: 15 },
  // Haiku 5.5 costs more for prompts above 100k tokens.
  {
    model: 'claude-haiku-5-5', label: 'Haiku 5.5', input: 0.1, cacheRead: 0.01, output: 0.5,
    longAbove: 100_000, longInput: 0.5, longCacheRead: 0.05, longOutput: 2.5
  },
  { model: 'claude-haiku-4-5', label: 'Haiku 4.5', input: 1, cacheRead: 0.1, output: 5 }
];

export const HAIKU = 'claude-haiku-5-5';

// Prices for models not in the table, by family: the older, higher prices, so estimates do not come out too low.
const FAMILY = [
  { match: /fable|mythos/, input: 10, cacheRead: 1, output: 50 },
  { match: /opus/, input: 5, cacheRead: 0.5, output: 25 },
  { match: /sonnet/, input: 3, cacheRead: 0.3, output: 15 },
  { match: /haiku/, input: 1, cacheRead: 0.1, output: 5 }
];

// claude-opus-5-5[1m] and claude-opus-5-5-20260401 are both claude-opus-5-5.
export function baseModel(model) {
  return String(model || '').toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

export function priceOf(model) {
  const base = baseModel(model);
  const known = PRICES.find(price => price.model === base);
  if (known) return { ...known, known: true };
  const family = FAMILY.find(item => item.match.test(base)) || FAMILY[1];
  return { model: base, label: base, input: family.input, cacheRead: family.cacheRead, output: family.output, known: false };
}

export function labelOf(model) {
  return model ? priceOf(model).label : '';
}

// Price per million tokens for one kind of token, for a prompt of the given total size.
export function rate(price, kind, promptTokens, ttl = '5m') {
  const long = price.longAbove && promptTokens > price.longAbove;
  const input = long ? price.longInput : price.input;
  if (kind === 'cacheRead') return long ? price.longCacheRead : price.cacheRead;
  if (kind === 'cacheWrite') return input * (ttl === '1h' ? 2 : 1.25);
  if (kind === 'output') return long ? price.longOutput : price.output;
  return input;
}
