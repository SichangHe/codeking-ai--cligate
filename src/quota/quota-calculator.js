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
    requests: sum.requests + (finite(receipt.requests) ?? 1),
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
  receiptCoverage = {},
  config = {},
  nowMs = Date.now()
}) {
  const providerStatus = staleStatus(status, config.staleAfterMs ?? 15 * 60 * 1000, nowMs);
  const providerBlocked = status?.allowed === false || status?.limitReached === true;
  const usedPercent = clampPercent(status?.usedPercent);
  const configuredBudgetUsd = finite(config.quotaBudgetUsd);
  const configuredBudgetTokens = finite(config.quotaBudgetTokens);
  const resetAtMs = parseTime(status?.resetAt);
  const resetElapsed = providerStatus === 'ok' && resetAtMs !== null && resetAtMs <= nowMs;
  const accountState = providerStatus === 'ok' && providerBlocked
    ? 'blocked'
    : resetElapsed ? 'reset_due' : providerStatus;
  const receiptCoverageComplete = receiptCoverage?.complete !== false;
  const resetWindowSeconds = finite(status?.windowSeconds) ?? finite(config.resetWindowSeconds);
  const windowStartMs = resetAtMs !== null && resetWindowSeconds !== null
    ? resetAtMs - resetWindowSeconds * 1000
    : nowMs - (config.smoothingWindowMs ?? DEFAULT_SMOOTHING_WINDOW_MS);
  const windowReceipts = receipts.filter(receipt => {
    const timestampMs = parseTime(receipt.timestamp);
    return timestampMs !== null && timestampMs >= windowStartMs && timestampMs <= nowMs;
  });
  const observed = sumReceipts(windowReceipts);
  const observedTokens = observed.inputTokens + observed.outputTokens;
  const receiptStartTimes = windowReceipts.map(receipt => parseTime(receipt.from || receipt.timestamp)).filter(timeMs => timeMs !== null);
  const receiptEndTimes = windowReceipts.map(receipt => parseTime(receipt.through || receipt.timestamp)).filter(timeMs => timeMs !== null);
  const velocity = computeVelocity(windowReceipts, {
    nowMs,
    windowMs: config.smoothingWindowMs ?? DEFAULT_SMOOTHING_WINDOW_MS
  });
  const secondsToReset = resetAtMs === null ? null : Math.max(0, (resetAtMs - nowMs) / 1000);
  const inferredBudgetUsd = configuredBudgetUsd === null && receiptCoverageComplete
    && usedPercent !== null && usedPercent > 0 && observed.costUsd > 0
    ? observed.costUsd / (usedPercent / 100)
    : null;
  const budgetUsd = configuredBudgetUsd ?? inferredBudgetUsd;
  const budgetSource = configuredBudgetUsd !== null ? 'configured' : inferredBudgetUsd !== null ? 'inferred_from_receipts' : 'unavailable';
  const remainingByProviderUsd = budgetUsd === null || usedPercent === null
    ? null
    : Math.max(0, budgetUsd * (1 - usedPercent / 100));
  const remainingByReceiptsUsd = budgetUsd === null ? null : Math.max(0, budgetUsd - observed.costUsd);
  const remainingUsd = accountState === 'ok' ? remainingByProviderUsd : null;
  const inferredBudgetTokens = configuredBudgetTokens === null && accountState === 'ok'
    && receiptCoverageComplete && resetAtMs !== null && usedPercent !== null && usedPercent > 0 && observedTokens > 0
    ? observedTokens / (usedPercent / 100)
    : null;
  const budgetTokens = configuredBudgetTokens ?? inferredBudgetTokens;
  const budgetTokensSource = configuredBudgetTokens !== null
    ? 'configured'
    : inferredBudgetTokens !== null ? 'inferred_from_counted_tokens_and_provider_percent' : 'unavailable';
  const remainingByProviderTokens = budgetTokens === null || usedPercent === null
    ? null
    : Math.max(0, budgetTokens * (1 - usedPercent / 100));
  const remainingAfterCountedTokens = budgetTokens === null ? null : Math.max(0, budgetTokens - observedTokens);
  const remainingTokens = accountState !== 'ok' || resetAtMs === null || remainingByProviderTokens === null
    || remainingAfterCountedTokens === null
    ? null
    : Math.min(remainingByProviderTokens, remainingAfterCountedTokens);
  const targetUsdPerSecond = remainingUsd === null || secondsToReset === null || secondsToReset <= 0
    ? null
    : (remainingUsd * (1 - (finite(config.safetyMargin) ?? DEFAULT_SAFETY_MARGIN))) / secondsToReset;
  const targetTokensPerSecond = remainingTokens === null || secondsToReset === null || secondsToReset <= 0
    ? null
    : (remainingTokens * (1 - (finite(config.safetyMargin) ?? DEFAULT_SAFETY_MARGIN))) / secondsToReset;
  const actualUsdPerSecond = observedTokens > 0 && observed.costUsd === 0 ? null : velocity.usdPerSecond;
  const dollarSignal = signalFor(actualUsdPerSecond, targetUsdPerSecond, config.safetyMargin);
  const tokenSignal = signalFor(velocity.tokensPerSecond, targetTokensPerSecond, config.safetyMargin);
  const signal = dollarSignal !== 'unavailable' ? dollarSignal : tokenSignal;
  const warnings = [];
  if (providerStatus !== 'ok') warnings.push(`provider_status_${providerStatus}`);
  if (providerBlocked) warnings.push('provider_reports_blocked');
  if (resetElapsed) warnings.push('provider_reset_elapsed');
  if (!receiptCoverageComplete) warnings.push('counted_receipts_incomplete');
  if (usedPercent === null) warnings.push('provider_percent_unavailable');
  if (budgetUsd === null) warnings.push('quota_budget_unconfigured');
  if (budgetUsd === null && configuredBudgetUsd === null && !receiptCoverageComplete && observed.costUsd > 0) warnings.push('quota_budget_needs_complete_receipts');
  if (budgetSource === 'inferred_from_receipts') warnings.push('quota_budget_inferred_from_partial_receipts');
  if (budgetTokensSource === 'inferred_from_counted_tokens_and_provider_percent') warnings.push('token_budget_inferred_from_partial_receipts');
  if (budgetTokens === null && configuredBudgetTokens === null && !receiptCoverageComplete && usedPercent !== null && usedPercent > 0 && observedTokens > 0) warnings.push('token_budget_needs_complete_receipts');
  if (budgetTokens === null && configuredBudgetTokens === null && (usedPercent === null || usedPercent <= 0)) warnings.push('token_budget_needs_positive_provider_percent');
  if (budgetTokens === null && configuredBudgetTokens === null && observedTokens <= 0) warnings.push('token_budget_needs_counted_receipts');
  if (observedTokens > 0 && observed.costUsd === 0) warnings.push('receipt_pricing_unavailable');
  if (resetAtMs === null) warnings.push('reset_time_unavailable');
  if (velocity.sampleCount < 2) warnings.push('velocity_needs_two_samples');
  if (remainingByProviderUsd !== null && remainingByReceiptsUsd !== null && Math.abs(remainingByProviderUsd - remainingByReceiptsUsd) > 0.01) {
    warnings.push('provider_and_receipt_estimates_differ');
  }
  if (remainingByProviderTokens !== null && remainingAfterCountedTokens !== null
    && Math.abs(remainingByProviderTokens - remainingAfterCountedTokens) > 1) {
    warnings.push('provider_and_counted_token_estimates_differ');
  }
  return {
    schemaVersion: 1,
    account: account.email,
    provider: account.provider || 'codex',
    planType: account.planType || null,
    state: accountState,
    source: status?.source || 'unavailable',
    measured: {
      fetchedAt: status?.fetchedAt || null,
      usedPercent,
      remainingPercent: usedPercent === null ? null : 100 - usedPercent,
      resetAt: status?.resetAt || null,
      windowSeconds: resetWindowSeconds,
      allowed: status?.allowed ?? null,
      limitReached: status?.limitReached ?? null
    },
    counted: {
      usedTokens: observedTokens,
      inputTokens: observed.inputTokens,
      outputTokens: observed.outputTokens,
      requests: observed.requests,
      from: receiptStartTimes.length ? new Date(Math.min(...receiptStartTimes)).toISOString() : null,
      through: receiptEndTimes.length ? new Date(Math.max(...receiptEndTimes)).toISOString() : null,
      complete: receiptCoverageComplete,
      completeFrom: receiptCoverage?.completeFrom || null,
      truncated: receiptCoverage?.truncated === true
    },
    estimated: {
      quotaBudgetUsd: budgetUsd,
      quotaBudgetSource: budgetSource,
      remainingEquivalentQuotaUsd: remainingUsd,
      remainingAfterObservedSpendUsd: remainingByReceiptsUsd,
      observedSpendUsd: observed.costUsd,
      observedTokens,
      quotaBudgetTokens: budgetTokens,
      quotaBudgetTokensSource: budgetTokensSource,
      remainingTokens,
      remainingAfterCountedTokens,
      targetBurnRateUsdPerSecond: targetUsdPerSecond,
      targetBurnRateTokensPerSecond: targetTokensPerSecond,
      actualVelocityUsdPerSecond: actualUsdPerSecond,
      actualVelocityTokensPerSecond: velocity.tokensPerSecond,
      signal,
      signalSource: dollarSignal !== 'unavailable' ? 'usd' : tokenSignal !== 'unavailable' ? 'tokens' : 'unavailable'
    },
    uncertainty: warnings,
    receipts: { requests: observed.requests, measuredFrom: velocity.measuredFrom }
  };
}

export function aggregateQuota(accounts = [], { nowMs = Date.now(), safetyMargin = DEFAULT_SAFETY_MARGIN } = {}) {
  const dollarUsable = accounts.filter(account => account.state === 'ok' && account.estimated.remainingEquivalentQuotaUsd !== null);
  const tokenUsable = accounts.filter(account => account.state === 'ok' && account.estimated.remainingTokens !== null);
  const usable = accounts.filter(account => dollarUsable.includes(account) || tokenUsable.includes(account));
  const target = dollarUsable.reduce((sum, account) => sum + (account.estimated.targetBurnRateUsdPerSecond || 0), 0);
  const velocityAccounts = dollarUsable.filter(account => account.estimated.actualVelocityUsdPerSecond !== null);
  const velocity = velocityAccounts.length
    ? velocityAccounts.reduce((sum, account) => sum + account.estimated.actualVelocityUsdPerSecond, 0)
    : null;
  const targetTokens = tokenUsable.reduce((sum, account) => sum + (account.estimated.targetBurnRateTokensPerSecond || 0), 0);
  const tokenVelocityAccounts = tokenUsable.filter(account => account.estimated.actualVelocityTokensPerSecond !== null);
  const tokenVelocity = tokenVelocityAccounts.length
    ? tokenVelocityAccounts.reduce((sum, account) => sum + account.estimated.actualVelocityTokensPerSecond, 0)
    : null;
  const nextResetAt = usable.map(account => account.measured.resetAt).filter(Boolean).sort()[0] || null;
  const remaining = dollarUsable.reduce((sum, account) => sum + account.estimated.remainingEquivalentQuotaUsd, 0);
  const remainingTokens = tokenUsable.reduce((sum, account) => sum + account.estimated.remainingTokens, 0);
  const countedTokens = accounts.reduce((sum, account) => sum + (account.counted?.usedTokens || 0), 0);
  const countedTokensComplete = accounts.length ? accounts.every(account => account.counted?.complete !== false) : null;
  const observedSpend = accounts.reduce((sum, account) => sum + (account.estimated.observedSpendUsd || 0), 0);
  const state = usable.length === accounts.length && accounts.length > 0 ? 'ok' : usable.length > 0 ? 'degraded' : 'unavailable';
  const dollarSignal = signalFor(velocity, dollarUsable.length ? target : null, safetyMargin);
  const tokenSignal = signalFor(tokenVelocity, tokenUsable.length ? targetTokens : null, safetyMargin);
  return {
    state,
    remainingEquivalentQuotaUsd: dollarUsable.length ? remaining : null,
    countedTokensUsed: countedTokens,
    countedTokensComplete,
    remainingTokens: tokenUsable.length ? remainingTokens : null,
    observedSpendUsd: observedSpend,
    targetBurnRateUsdPerSecond: dollarUsable.length ? target : null,
    targetBurnRateTokensPerSecond: tokenUsable.length ? targetTokens : null,
    actualVelocityUsdPerSecond: velocity,
    actualVelocityTokensPerSecond: tokenVelocity,
    nextResetAt,
    signal: dollarSignal !== 'unavailable' ? dollarSignal : tokenSignal,
    signalSource: dollarSignal !== 'unavailable' ? 'usd' : tokenSignal !== 'unavailable' ? 'tokens' : 'unavailable',
    accountCount: accounts.length,
    usableAccountCount: usable.length,
    dollarEstimateAccountCount: dollarUsable.length,
    tokenEstimateAccountCount: tokenUsable.length,
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
