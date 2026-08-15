import { getQuotaUsageReceipts, setQuotaUsageWindow } from '../usage-tracker.js';
import { estimateCostWithRegistry } from '../pricing-registry.js';
import { loadAccounts, updateAccountQuota } from '../account-manager.js';
import { getAccountQuota as fetchAccountQuota } from '../model-api.js';
import {
  computeAccountQuota,
  aggregateQuota,
  isRoutableAccount,
  TOKEN_ESTIMATE_NOTE
} from './quota-calculator.js';
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

export function normalizeCodexStatus(email, quota, previous) {
  const usage = quota?.usage;
  const usedPercentValue = usage?.percentage ?? usage?.totalTokenUsage;
  const usedPercentRaw = usedPercentValue === null || usedPercentValue === undefined
    ? null
    : Number(usedPercentValue);
  const usedPercent = Number.isFinite(usedPercentRaw) ? usedPercentRaw : null;
  const resetAt = usage?.resetAt && Number.isFinite(Date.parse(usage.resetAt)) ? usage.resetAt : null;
  const windowSeconds = usage?.limitWindowSeconds === null || usage?.limitWindowSeconds === undefined
    ? null
    : Number(usage.limitWindowSeconds);
  return {
    key: `codex:${email}`,
    provider: 'codex',
    account: email,
    state: usedPercent === null ? 'error' : 'ok',
    source: usedPercent === null ? 'provider_api_unavailable' : 'provider_api_measured',
    usedPercent,
    resetAt,
    windowSeconds: Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : null,
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
      setQuotaUsageWindow({
        provider: 'chatgpt-pool', keyId: account.email, resetAt: status.resetAt,
        windowSeconds: status.windowSeconds ?? config.providers.codex.resetWindowSeconds
      });
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

function receiptsFor(email, { fromMs, throughMs }) {
  const result = getQuotaUsageReceipts({ provider: 'chatgpt-pool', keyId: email, fromMs, throughMs });
  return {
    receipts: result.receipts
      .filter(receipt => receipt.provider === 'chatgpt-pool' && receipt.keyId === email)
      .filter(receipt => (Number(receipt.inputTokens) || 0) + (Number(receipt.outputTokens) || 0) > 0 || Number(receipt.cost) > 0)
      .map(receipt => ({ ...receipt, costUsd: receiptCost(receipt) })),
    coverage: result.coverage
  };
}

export function buildQuotaSnapshot({ nowMs = Date.now() } = {}) {
  const config = store.getConfig();
  const accounts = (loadAccounts().accounts || []).filter(isRoutableAccount).map(account => {
    const override = config.accountOverrides[account.email] || {};
    const providerConfig = config.providers.codex;
    const status = store.getStatuses()[`codex:${account.email}`] || {
      state: 'unavailable', source: 'provider_api_unavailable', fetchedAt: null
    };
    const resetAtMs = Date.parse(status.resetAt || '');
    const configuredWindowSeconds = override.resetWindowSeconds ?? providerConfig.resetWindowSeconds;
    const statusWindowSeconds = status.windowSeconds === null || status.windowSeconds === undefined
      ? null
      : Number(status.windowSeconds);
    const resetWindowSeconds = Number.isFinite(statusWindowSeconds) && statusWindowSeconds > 0
      ? statusWindowSeconds
      : configuredWindowSeconds;
    setQuotaUsageWindow({
      provider: 'chatgpt-pool', keyId: account.email,
      resetAt: status.resetAt, windowSeconds: resetWindowSeconds
    });
    const windowStartMs = Number.isFinite(resetAtMs) && Number.isFinite(Number(resetWindowSeconds))
      ? resetAtMs - Number(resetWindowSeconds) * 1000
      : nowMs - config.smoothingWindowMs;
    const receiptData = receiptsFor(account.email, { fromMs: windowStartMs, throughMs: nowMs });
    return computeAccountQuota({
      account: { email: account.email, provider: 'codex', planType: account.planType },
      status,
      receipts: receiptData.receipts,
      receiptCoverage: receiptData.coverage,
      config: {
        ...config,
        quotaBudgetUsd: override.quotaBudgetUsd ?? providerConfig.quotaBudgetUsd,
        quotaBudgetTokens: override.quotaBudgetTokens ?? providerConfig.quotaBudgetTokens,
        resetWindowSeconds: configuredWindowSeconds
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

function numericOrZero(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function buildQuotaSummary(snapshot) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const aggregate = snapshot?.aggregate || {};
  return {
    schemaVersion: snapshot?.schemaVersion || 1,
    generatedAt: snapshot?.generatedAt || null,
    state: snapshot?.state || aggregate.state || 'unavailable',
    aggregate: {
      state: aggregate.state || snapshot?.state || 'unavailable',
      accountCount: aggregate.accountCount ?? accounts.length,
      usableAccountCount: aggregate.usableAccountCount ?? 0,
      counted: {
        usedTokens: numericOrZero(aggregate.countedTokensUsed),
        complete: aggregate.countedTokensComplete ?? null,
        actualVelocityUsdPerSecond: numericOrNull(aggregate.actualVelocityUsdPerSecond),
        dollarVelocityAccountCount: numericOrZero(aggregate.dollarVelocityAccountCount),
        actualVelocityTokensPerSecond: numericOrNull(aggregate.actualVelocityTokensPerSecond),
        tokenVelocityAccountCount: numericOrZero(aggregate.tokenVelocityAccountCount)
      },
      estimated: {
        remainingTokens: numericOrZero(aggregate.remainingTokens),
        remainingEquivalentQuotaUsd: numericOrNull(aggregate.remainingEquivalentQuotaUsd),
        targetBurnRateUsdPerSecond: numericOrNull(aggregate.targetBurnRateUsdPerSecond),
        dollarTargetAccountCount: numericOrZero(aggregate.dollarTargetAccountCount),
        targetBurnRateTokensPerSecond: numericOrNull(aggregate.targetBurnRateTokensPerSecond),
        tokenTargetAccountCount: numericOrZero(aggregate.tokenTargetAccountCount),
        reliable: aggregate.remainingTokensReliable === true,
        accountCount: aggregate.numericTokenEstimateAccountCount ?? accounts.length,
        usableAccountCount: aggregate.tokenEstimateAccountCount ?? 0,
        fallbackAccountCount: aggregate.fallbackTokenEstimateAccountCount ?? 0,
        reliableAccountCount: aggregate.reliableTokenEstimateAccountCount ?? 0,
        note: aggregate.remainingTokensNote || TOKEN_ESTIMATE_NOTE,
        reasons: aggregate.remainingTokensReasons || []
      },
      nextResetAt: aggregate.nextResetAt || null,
      signal: aggregate.signal || 'unavailable',
      signalSource: aggregate.signalSource || 'unavailable'
    },
    accounts: accounts.map(account => ({
      account: account.account,
      provider: account.provider,
      planType: account.planType || null,
      state: account.state,
      source: account.source,
      measured: {
        fetchedAt: account.measured?.fetchedAt || null,
        usedPercent: account.measured?.usedPercent ?? null,
        remainingPercent: account.measured?.remainingPercent ?? null,
        resetAt: account.measured?.resetAt || null,
        windowSeconds: account.measured?.windowSeconds ?? null,
        allowed: account.measured?.allowed ?? null,
        limitReached: account.measured?.limitReached ?? null
      },
      counted: {
        usedTokens: numericOrZero(account.counted?.usedTokens),
        inputTokens: numericOrZero(account.counted?.inputTokens),
        outputTokens: numericOrZero(account.counted?.outputTokens),
        requests: numericOrZero(account.counted?.requests),
        complete: account.counted?.complete ?? null,
        completeFrom: account.counted?.completeFrom || null,
        truncated: account.counted?.truncated === true,
        from: account.counted?.from || null,
        through: account.counted?.through || null
      },
      estimated: {
        remainingTokens: numericOrZero(account.estimated?.remainingTokens),
        reliable: account.estimated?.remainingTokensReliable === true,
        method: account.estimated?.remainingTokensMethod || 'conservative_zero_fallback',
        note: account.estimated?.remainingTokensNote || TOKEN_ESTIMATE_NOTE,
        reasons: account.estimated?.remainingTokensReasons || ['estimate_metadata_unavailable']
      }
    })),
    links: {
      full: '/api/quota',
      help: '/api/quota/help'
    }
  };
}

export async function getQuotaSnapshot({ refresh = false } = {}) {
  if (refresh || Object.keys(store.getStatuses()).length === 0) await refreshQuotaStatuses({ force: refresh });
  return buildQuotaSnapshot();
}

export async function getQuotaSummary({ refresh = false } = {}) {
  return buildQuotaSummary(await getQuotaSnapshot({ refresh }));
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
