import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from '../account-manager.js';
import { retainHistory } from './quota-calculator.js';

export const DEFAULT_QUOTA_CONFIG = {
  schemaVersion: 1,
  pollingIntervalMs: 5 * 60 * 1000,
  staleAfterMs: 15 * 60 * 1000,
  smoothingWindowMs: 60 * 60 * 1000,
  retentionDays: 30,
  maxHistoryEntries: 5000,
  safetyMargin: 0.15,
  providers: {
    codex: { enabled: true, quotaBudgetUsd: null, resetWindowSeconds: 5 * 60 * 60 }
  },
  accountOverrides: {}
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJson(file, fallback) {
  if (!existsSync(file)) return clone(fallback);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return clone(fallback);
  }
}

function finiteOr(value, fallback, { min = 0, max = Infinity } = {}) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function optionalNonNegative(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeConfig(value) {
  const input = value && typeof value === 'object' ? value : {};
  const codex = input.providers?.codex || {};
  const accountOverrides = input.accountOverrides && typeof input.accountOverrides === 'object' ? input.accountOverrides : {};
  const normalizedOverrides = {};
  for (const [email, override] of Object.entries(accountOverrides)) {
    if (!email || !override || typeof override !== 'object') continue;
    normalizedOverrides[email] = {
      quotaBudgetUsd: optionalNonNegative(override.quotaBudgetUsd, undefined),
      resetWindowSeconds: finiteOr(override.resetWindowSeconds, undefined, { min: 60, max: 31_536_000 })
    };
    for (const key of Object.keys(normalizedOverrides[email])) {
      if (normalizedOverrides[email][key] === undefined) delete normalizedOverrides[email][key];
    }
  }
  return {
    schemaVersion: 1,
    pollingIntervalMs: finiteOr(input.pollingIntervalMs, DEFAULT_QUOTA_CONFIG.pollingIntervalMs, { min: 10_000, max: 86_400_000 }),
    staleAfterMs: finiteOr(input.staleAfterMs, DEFAULT_QUOTA_CONFIG.staleAfterMs, { min: 30_000, max: 7 * 86_400_000 }),
    smoothingWindowMs: finiteOr(input.smoothingWindowMs, DEFAULT_QUOTA_CONFIG.smoothingWindowMs, { min: 60_000, max: 7 * 86_400_000 }),
    retentionDays: finiteOr(input.retentionDays, DEFAULT_QUOTA_CONFIG.retentionDays, { min: 1, max: 3650 }),
    maxHistoryEntries: finiteOr(input.maxHistoryEntries, DEFAULT_QUOTA_CONFIG.maxHistoryEntries, { min: 100, max: 100_000 }),
    safetyMargin: finiteOr(input.safetyMargin, DEFAULT_QUOTA_CONFIG.safetyMargin, { min: 0, max: 0.95 }),
    providers: {
      codex: {
        enabled: codex.enabled !== false,
        quotaBudgetUsd: optionalNonNegative(codex.quotaBudgetUsd, DEFAULT_QUOTA_CONFIG.providers.codex.quotaBudgetUsd),
        resetWindowSeconds: finiteOr(codex.resetWindowSeconds, DEFAULT_QUOTA_CONFIG.providers.codex.resetWindowSeconds, { min: 60, max: 31_536_000 })
      }
    },
    accountOverrides: normalizedOverrides
  };
}

export function createQuotaStore({ configDir = CONFIG_DIR, now = () => Date.now() } = {}) {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configFile = join(configDir, 'quota-config.json');
  const statusFile = join(configDir, 'quota-status.json');
  const historyFile = join(configDir, 'quota-history.json');
  let config = normalizeConfig(readJson(configFile, DEFAULT_QUOTA_CONFIG));
  let statuses = readJson(statusFile, {});
  const storedHistory = readJson(historyFile, []);
  let history = Array.isArray(storedHistory) ? storedHistory : [];

  function save() {
    writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    writeFileSync(statusFile, JSON.stringify(statuses, null, 2), { mode: 0o600 });
    history = retainHistory(history, { nowMs: now(), retentionDays: config.retentionDays, maxEntries: config.maxHistoryEntries });
    writeFileSync(historyFile, JSON.stringify(history), { mode: 0o600 });
  }

  return {
    getConfig() { return clone(config); },
    setConfig(next) {
      config = normalizeConfig({
        ...config,
        ...(next || {}),
        providers: { codex: { ...config.providers.codex, ...(next?.providers?.codex || {}) } },
        accountOverrides: next?.accountOverrides ?? config.accountOverrides
      });
      save();
      return clone(config);
    },
    getStatuses() { return clone(statuses); },
    setStatus(key, status) {
      statuses[key] = { ...status, key, updatedAt: new Date(now()).toISOString() };
      save();
      return clone(statuses[key]);
    },
    addObservation(observation) {
      history.push({ ...observation, at: observation.at || new Date(now()).toISOString() });
      history = retainHistory(history, { nowMs: now(), retentionDays: config.retentionDays, maxEntries: config.maxHistoryEntries });
      save();
    },
    getHistory(limit = 200) { return clone(history.slice(0, Math.max(0, Math.min(1000, Number(limit) || 200)))); },
    flush: save
  };
}
