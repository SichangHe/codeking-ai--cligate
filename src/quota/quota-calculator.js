const DEFAULT_SMOOTHING_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_SAFETY_MARGIN = 0.15;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  const number = finite(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
}

function parseTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

function emptyVelocity() {
  return { usdPerSecond: null, tokensPerSecond: null, sampleCount: 0, measuredFrom: null };
}

export function isRoutableAccount(account) {
  return Boolean(account?.email) && account.enabled !== false;
}

export function sumReceipts(receipts = []) {
  return receipts.reduce((sum, receipt) => ({
    requests: sum.requests + 1,
    inputTokens: sum.inputTokens + (finite(receipt.inputTokens) || 0),
    outputTokens: sum.outputTokens + (finite(receipt.outputTokens) || 0),
    costUsd: sum.costUsd + (finite(receipt.costUsd ?? receipt.cost) || 0)
  }), { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
}

export function computeVelocity(receipts = [], { nowMs = Date.now(), windowMs = DEFAULT_SMOOTHING_WINDOW_MS } = {}) {
  const cutoffMs = nowMs - Math.max(1, windowMs);
  const samples = receipts
    .map(receipt => ({ ...receipt, timeMs: parseTime(receipt.timestamp) }))
    .filter(receipt => receipt.timeMs !== null && receipt.timeMs >= cutoffMs && receipt.timeMs <= nowMs)
    .sort((a, b) => a.timeMs - b.timeMs);
  if (samples.length < 2) return emptyVelocity();
  const totals = sumReceipts(samples);
  const elapsedSeconds = Math.max(1, (nowMs - samples[0].timeMs) / 1000);
  return {
    usdPerSecond: totals.costUsd / elapsedSeconds,
    tokensPerSecond: (totals.inputTokens + totals.outputTokens) / elapsedSeconds,
    sampleCount: samples.length,
    measuredFrom: new Date(samples[0].timeMs).toISOString()
  };
}

function signalFor(actualUsdPerSecond, targetUsdPerSecond, safetyMargin) {
  if (actualUsdPerSecond === null || targetUsdPerSecond === null || targetUsdPerSecond <= 0) return 'unavailable';
  const margin = Math.max(0, Math.min(0.95, finite(safetyMargin) ?? DEFAULT_SAFETY_MARGIN));
  if (actualUsdPerSecond > targetUsdPerSecond * (1 + margin)) return 'slow_down';
  if (actualUsdPerSecond < targetUsdPerSecond * (1 - margin)) return 'speed_up';
  return 'on_track';
}

function staleStatus(status, staleAfterMs, nowMs) {
  const fetchedAtMs = parseTime(status?.fetchedAt);
  if (!fetchedAtMs) return 'unavailable';
  if (status?.state === 'error') return 'error';
  return nowMs - fetchedAtMs > staleAfterMs ? 'stale' : 'ok';
}

export function computeAccountQuota({
  account,
  status,
  receipts = [],
  config = {},
  nowMs = Date.now()
}) {
  const providerStatus = staleStatus(status, config.staleAfterMs ?? 15 * 60 * 1000, nowMs);
  const usedPercent = clampPercent(status?.usedPercent);
  const configuredBudgetUsd = finite(config.quotaBudgetUsd);
  const resetAtMs = parseTime(status?.resetAt);
  const resetWindowSeconds = finite(status?.windowSeconds) ?? finite(config.resetWindowSeconds);
  const windowStartMs = resetAtMs !== null && resetWindowSeconds !== null
    ? resetAtMs - resetWindowSeconds * 1000
    : nowMs - (config.smoothingWindowMs ?? DEFAULT_SMOOTHING_WINDOW_MS);
  const windowReceipts = receipts.filter(receipt => {
    const timestampMs = parseTime(receipt.timestamp);
    return timestampMs !== null && timestampMs >= windowStartMs && timestampMs <= nowMs;
  });
  const observed = sumReceipts(windowReceipts);
  const velocity = computeVelocity(windowReceipts, {
    nowMs,
    windowMs: config.smoothingWindowMs ?? DEFAULT_SMOOTHING_WINDOW_MS
  });
  const secondsToReset = resetAtMs === null ? null : Math.max(0, (resetAtMs - nowMs) / 1000);
  const inferredBudgetUsd = configuredBudgetUsd === null && usedPercent !== null && usedPercent > 0 && observed.costUsd > 0
    ? observed.costUsd / (usedPercent / 100)
    : null;
  const budgetUsd = configuredBudgetUsd ?? inferredBudgetUsd;
  const budgetSource = configuredBudgetUsd !== null ? 'configured' : inferredBudgetUsd !== null ? 'inferred_from_receipts' : 'unavailable';
  const remainingByProviderUsd = budgetUsd === null || usedPercent === null
    ? null
    : Math.max(0, budgetUsd * (1 - usedPercent / 100));
  const remainingByReceiptsUsd = budgetUsd === null ? null : Math.max(0, budgetUsd - observed.costUsd);
  const remainingUsd = providerStatus === 'ok' ? remainingByProviderUsd : null;
  const targetUsdPerSecond = remainingUsd === null || secondsToReset === null || secondsToReset <= 0
    ? null
    : (remainingUsd * (1 - (finite(config.safetyMargin) ?? DEFAULT_SAFETY_MARGIN))) / secondsToReset;
  const warnings = [];
  if (providerStatus !== 'ok') warnings.push(`provider_status_${providerStatus}`);
  if (usedPercent === null) warnings.push('provider_percent_unavailable');
  if (budgetUsd === null) warnings.push('quota_budget_unconfigured');
  if (budgetSource === 'inferred_from_receipts') warnings.push('quota_budget_inferred_from_partial_receipts');
  if (observed.inputTokens + observed.outputTokens > 0 && observed.costUsd === 0) warnings.push('receipt_pricing_unavailable');
  if (resetAtMs === null) warnings.push('reset_time_unavailable');
  if (velocity.sampleCount < 2) warnings.push('velocity_needs_two_samples');
  if (remainingByProviderUsd !== null && remainingByReceiptsUsd !== null && Math.abs(remainingByProviderUsd - remainingByReceiptsUsd) > 0.01) {
    warnings.push('provider_and_receipt_estimates_differ');
  }
  return {
    schemaVersion: 1,
    account: account.email,
    provider: account.provider || 'codex',
    planType: account.planType || null,
    state: providerStatus,
    source: status?.source || 'unavailable',
    measured: {
      fetchedAt: status?.fetchedAt || null,
      usedPercent,
      resetAt: status?.resetAt || null,
      windowSeconds: resetWindowSeconds,
      allowed: status?.allowed ?? null,
      limitReached: status?.limitReached ?? null
    },
    estimated: {
      quotaBudgetUsd: budgetUsd,
      quotaBudgetSource: budgetSource,
      remainingEquivalentQuotaUsd: remainingUsd,
      remainingAfterObservedSpendUsd: remainingByReceiptsUsd,
      observedSpendUsd: observed.costUsd,
      observedTokens: observed.inputTokens + observed.outputTokens,
      targetBurnRateUsdPerSecond: targetUsdPerSecond,
      actualVelocityUsdPerSecond: velocity.usdPerSecond,
      actualVelocityTokensPerSecond: velocity.tokensPerSecond,
      signal: signalFor(velocity.usdPerSecond, targetUsdPerSecond, config.safetyMargin)
    },
    uncertainty: warnings,
    receipts: { requests: observed.requests, measuredFrom: velocity.measuredFrom }
  };
}

export function aggregateQuota(accounts = [], { nowMs = Date.now(), safetyMargin = DEFAULT_SAFETY_MARGIN } = {}) {
  const usable = accounts.filter(account => account.state === 'ok' && account.estimated.remainingEquivalentQuotaUsd !== null);
  const target = usable.reduce((sum, account) => sum + (account.estimated.targetBurnRateUsdPerSecond || 0), 0);
  const velocityAccounts = usable.filter(account => account.estimated.actualVelocityUsdPerSecond !== null);
  const velocity = velocityAccounts.length
    ? velocityAccounts.reduce((sum, account) => sum + account.estimated.actualVelocityUsdPerSecond, 0)
    : null;
  const nextResetAt = usable.map(account => account.measured.resetAt).filter(Boolean).sort()[0] || null;
  const remaining = usable.reduce((sum, account) => sum + account.estimated.remainingEquivalentQuotaUsd, 0);
  const observedSpend = accounts.reduce((sum, account) => sum + (account.estimated.observedSpendUsd || 0), 0);
  const state = usable.length === accounts.length && accounts.length > 0 ? 'ok' : usable.length > 0 ? 'degraded' : 'unavailable';
  return {
    state,
    remainingEquivalentQuotaUsd: usable.length ? remaining : null,
    observedSpendUsd: observedSpend,
    targetBurnRateUsdPerSecond: usable.length ? target : null,
    actualVelocityUsdPerSecond: velocity,
    nextResetAt,
    signal: signalFor(velocity, target, safetyMargin),
    accountCount: accounts.length,
    usableAccountCount: usable.length,
    uncertainty: accounts.flatMap(account => account.uncertainty || [])
  };
}

export function retainHistory(entries, { nowMs = Date.now(), retentionDays = 30, maxEntries = 5000 } = {}) {
  const cutoffMs = nowMs - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  return entries
    .filter(entry => {
      const timeMs = parseTime(entry.at || entry.timestamp);
      return timeMs !== null && timeMs >= cutoffMs && timeMs <= nowMs;
    })
    .sort((a, b) => String(b.at || b.timestamp).localeCompare(String(a.at || a.timestamp)))
    .slice(0, Math.max(1, maxEntries));
}
