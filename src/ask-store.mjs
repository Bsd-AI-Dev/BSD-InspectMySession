// Settings and the ask log, kept next to server.json (default ~/.cache/bsd-ims/).
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  askModel: 'auto',
  cacheLifetime: 'detect',
  costLimitUsd: 0.1,
  askTimeoutMinutes: 3,
  keepQuestionText: true
};

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,80}(\[[A-Za-z0-9]{1,10}\])?$/;
const CHECKS = {
  askModel: value => value === 'auto' || value === 'session' || (typeof value === 'string' && MODEL_ID.test(value)),
  cacheLifetime: value => ['detect', '5m', '1h'].includes(value),
  costLimitUsd: value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100,
  askTimeoutMinutes: value => Number.isInteger(value) && value >= 1 && value <= 30,
  keepQuestionText: value => typeof value === 'boolean'
};

export function isModelId(value) {
  return typeof value === 'string' && MODEL_ID.test(value);
}

// Checks a partial update; returns the error text, or '' when every given value is allowed.
export function settingsError(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return 'Settings must be an object.';
  for (const [key, value] of Object.entries(update)) {
    if (!CHECKS[key]) return `Unknown setting: ${key}.`;
    if (!CHECKS[key](value)) return `Invalid value for ${key}.`;
  }
  return '';
}

export function askStore(dataDir) {
  const settingsFile = path.join(dataDir, 'settings.json');
  const logFile = path.join(dataDir, 'asks.jsonl');

  async function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(await readFile(settingsFile, 'utf8')); } catch {}
    const settings = { ...DEFAULT_SETTINGS };
    // A hand-edited file with a bad value falls back to the default for that value only.
    for (const key of Object.keys(DEFAULT_SETTINGS)) if (key in saved && CHECKS[key](saved[key])) settings[key] = saved[key];
    return settings;
  }

  async function saveSettings(update) {
    const settings = { ...(await loadSettings()), ...update };
    const temp = `${settingsFile}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`);
    await rename(temp, settingsFile);
    return settings;
  }

  async function addAsk(entry) {
    await appendFile(logFile, `${JSON.stringify(entry)}\n`);
  }

  // Newest first.
  async function readAsks(limit = 500) {
    let text = '';
    try { text = await readFile(logFile, 'utf8'); } catch { return []; }
    const asks = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { asks.push(JSON.parse(line)); } catch {}
    }
    return asks.reverse().slice(0, limit);
  }

  return { loadSettings, saveSettings, addAsk, readAsks };
}
