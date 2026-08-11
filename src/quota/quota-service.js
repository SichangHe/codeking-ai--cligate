import { getRecentHistory } from '../usage-tracker.js';
import { estimateCostWithRegistry } from '../pricing-registry.js';
import { loadAccounts, updateAccountQuota } from '../account-manager.js';
import { getAccountQuota as fetchAccountQuota } from '../model-api.js';
import { computeAccountQuota, aggregateQuota, isRoutableAccount } from './quota-calculator.js';
import { createQuotaStore } from './quota-store.js';

const store = createQuotaStore();
let refreshPromise = null;
let monitorTimer = null;

function safeErrorStatus(previous, error) {
  return {
    ...(previous || {}),
    state: 'error',
    source: previous?.source || 'provider_api',
    errorCode: 'provider_status_unavailable',
    errorAt: new Date().toISOString(),
    errorMessage: undefined,
    fetchedAt: previous?.fetchedAt || null,
    providerError: error ? true : false
  };
}

function normalizeCodexStatus(email, quota, previous) {
  const usage = quota?.usage;
  const usedPercent = Number(usage?.percentage ?? usage?.totalTokenUsage);
  const resetAt = usage?.resetAt && Number.isFinite(Date.parse(usage.resetAt)) ? usage.resetAt : null;
  const windowSeconds = Number(usage?.limitWindowSeconds);
  return {
    key: `codex:${email}`,
    provider: 'codex',
    account: email,
    state: Number.isFinite(usedPercent) ? 'ok' : 'error',
    source: Number.isFinite(usedPercent) ? 'provider_api_measured' : 'provider_api_unavailable',
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
    resetAt,
    windowSeconds: Number.isFinite(windowSeconds) ? windowSeconds : null,
    allowed: usage?.allowed ?? null,
    limitReached: usage?.limitReached ?? null,
    planType: usage?.planType || null,
    fetchedAt: quota?.fetchedAt || new Date().toISOString(),
    previousFetchedAt: previous?.fetchedAt || null
  };
}

async function refreshCodexStatuses(force) {
  const config = store.getConfig();
  if (config.providers.codex.enabled === false) return;
  const accounts = (loadAccounts().accounts || []).filter(isRoutableAccount);
  for (const account of accounts) {
    if (!account.email) continue;
    const key = `codex:${account.email}`;
    const previous = store.getStatuses()[key];
    const fetchedAtMs = Date.parse(previous?.fetchedAt || '');
    const fresh = Number.isFinite(fetchedAtMs) && Date.now() - fetchedAtMs <= config.staleAfterMs;
    if (!force && fresh) continue;
    try {
      if (!account.accessToken || !account.accountId) throw new Error('missing_provider_credentials');
      const quota = await fetchAccountQuota(account.accessToken, account.accountId);
      updateAccountQuota(account.email, quota);
      const status = normalizeCodexStatus(account.email, quota, previous);
      store.setStatus(key, status);
      store.addObservation({
        provider: 'codex', account: account.email, state: status.state,
        usedPercent: status.usedPercent, resetAt: status.resetAt,
        windowSeconds: status.windowSeconds, source: status.source
      });
    } catch (error) {
      const status = safeErrorStatus(previous, error);
      store.setStatus(key, status);
      store.addObservation({ provider: 'codex', account: account.email, state: 'error', source: 'provider_api_unavailable' });
    }
  }
}

export async function refreshQuotaStatuses({ force = false } = {}) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshCodexStatuses(force).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function receiptCost(receipt) {
  if (Number.isFinite(Number(receipt.cost)) && Number(receipt.cost) > 0) return Number(receipt.cost);
  return estimateCostWithRegistry('openai', receipt.model || 'gpt-5.3-codex', receipt.inputTokens || 0, receipt.outputTokens || 0, receipt.cacheReadTokens || 0);
}

function receiptsFor(email) {
  return getRecentHistory(5000)
    .filter(receipt => receipt.keyId === email && receipt.success !== false)
    .filter(receipt => (Number(receipt.inputTokens) || 0) + (Number(receipt.outputTokens) || 0) > 0 || Number(receipt.cost) > 0)
    .map(receipt => ({ ...receipt, costUsd: receiptCost(receipt) }));
}

export function buildQuotaSnapshot({ nowMs = Date.now() } = {}) {
  const config = store.getConfig();
  const accounts = (loadAccounts().accounts || []).filter(isRoutableAccount).map(account => {
    const override = config.accountOverrides[account.email] || {};
    const providerConfig = config.providers.codex;
    const status = store.getStatuses()[`codex:${account.email}`] || {
      state: 'unavailable', source: 'provider_api_unavailable', fetchedAt: null
    };
    return computeAccountQuota({
      account: { email: account.email, provider: 'codex', planType: account.planType },
      status,
      receipts: receiptsFor(account.email),
      config: {
        ...config,
        quotaBudgetUsd: override.quotaBudgetUsd ?? providerConfig.quotaBudgetUsd,
        resetWindowSeconds: override.resetWindowSeconds ?? providerConfig.resetWindowSeconds
      },
      nowMs
    });
  });
  const aggregate = aggregateQuota(accounts, { nowMs, safetyMargin: config.safetyMargin });
  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    state: aggregate.state,
    aggregate,
    accounts,
    config: {
      pollingIntervalMs: config.pollingIntervalMs,
      staleAfterMs: config.staleAfterMs,
      smoothingWindowMs: config.smoothingWindowMs,
      retentionDays: config.retentionDays,
      maxHistoryEntries: config.maxHistoryEntries,
      safetyMargin: config.safetyMargin,
      providers: config.providers,
      accountOverrides: config.accountOverrides
    }
  };
}

export async function getQuotaSnapshot({ refresh = false } = {}) {
  if (refresh || Object.keys(store.getStatuses()).length === 0) await refreshQuotaStatuses({ force: refresh });
  return buildQuotaSnapshot();
}

export function getQuotaHistory(limit) { return store.getHistory(limit); }
export function getQuotaConfig() { return store.getConfig(); }
export function updateQuotaConfig(config) {
  const updated = store.setConfig(config);
  if (monitorTimer) startQuotaMonitor();
  return updated;
}

export function startQuotaMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  const intervalMs = store.getConfig().pollingIntervalMs;
  refreshQuotaStatuses().catch(() => {});
  monitorTimer = setInterval(() => refreshQuotaStatuses().catch(() => {}), intervalMs);
  monitorTimer.unref?.();
  return stopQuotaMonitor;
}

export function stopQuotaMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}

export const quotaStoreForTests = store;
