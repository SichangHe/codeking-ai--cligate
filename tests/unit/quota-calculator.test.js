import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAccountQuota,
  aggregateQuota,
  isRoutableAccount,
  retainHistory
} from '../../src/quota/quota-calculator.js';

const nowMs = Date.parse('2026-08-10T20:00:00.000Z');

function account(overrides = {}) {
  return computeAccountQuota({
    account: { email: 'a@example.test', provider: 'codex', planType: 'plus' },
    status: {
      state: 'ok', source: 'provider_api_measured', usedPercent: 25,
      fetchedAt: '2026-08-10T19:59:00.000Z', resetAt: '2026-08-10T21:00:00.000Z',
      windowSeconds: 18_000, allowed: true, limitReached: false
    },
    receipts: [
      { timestamp: '2026-08-10T19:30:00.000Z', inputTokens: 1000, outputTokens: 100, costUsd: 2 },
      { timestamp: '2026-08-10T19:50:00.000Z', inputTokens: 2000, outputTokens: 200, costUsd: 4 },
      { timestamp: '2026-08-10T15:00:00.000Z', inputTokens: 99_000, outputTokens: 99_000, costUsd: 99 }
    ],
    config: {
      quotaBudgetUsd: 100, staleAfterMs: 300_000, smoothingWindowMs: 3_600_000,
      resetWindowSeconds: 18_000, safetyMargin: 0.1
    },
    nowMs,
    ...overrides
  });
}

test('calculates provider-based remaining quota, reset target, and receipt velocity', () => {
  const result = account();
  assert.equal(result.state, 'ok');
  assert.equal(result.estimated.remainingEquivalentQuotaUsd, 75);
  assert.equal(result.estimated.observedSpendUsd, 6);
  assert.equal(result.estimated.observedTokens, 3300);
  assert.equal(result.counted.usedTokens, 3300);
  assert.equal(result.estimated.quotaBudgetTokens, 13_200);
  assert.equal(result.estimated.quotaBudgetTokensSource, 'inferred_from_counted_tokens_and_provider_percent');
  assert.equal(result.estimated.remainingTokens, 9900);
  assert.equal(result.estimated.remainingTokensReliable, false);
  assert.equal(result.estimated.remainingTokensMethod, 'inferred_from_counted_tokens_and_provider_percent');
  assert.match(result.estimated.remainingTokensNote, /may be unreliable/i);
  assert.ok(result.estimated.remainingTokensReasons.includes('token_budget_inferred_from_counted_tokens_and_provider_percent'));
  assert.equal(result.estimated.targetBurnRateUsdPerSecond, 67.5 / 3600);
  assert.equal(result.estimated.targetBurnRateTokensPerSecond, 9900 * 0.9 / 3600);
  assert.equal(result.estimated.actualVelocityUsdPerSecond, 6 / 1800);
  assert.equal(result.estimated.signal, 'speed_up');
});

test('excludes receipts before the reset window boundary', () => {
  assert.equal(account().receipts.requests, 2);
});

test('infers an explicitly uncertain equivalent budget when no assumption is configured', () => {
  const result = account({ config: {
    quotaBudgetUsd: null, staleAfterMs: 300_000, smoothingWindowMs: 3_600_000,
    resetWindowSeconds: 18_000, safetyMargin: 0.1
  } });
  assert.equal(result.estimated.quotaBudgetUsd, 24);
  assert.equal(result.estimated.quotaBudgetSource, 'inferred_from_receipts');
  assert.equal(result.estimated.remainingEquivalentQuotaUsd, 18);
  assert.ok(result.uncertainty.includes('quota_budget_inferred_from_partial_receipts'));
});

test('uses an explicit token budget and the more conservative provider or receipt remainder', () => {
  const result = account({ config: {
    quotaBudgetUsd: null, quotaBudgetTokens: 20_000, staleAfterMs: 300_000,
    smoothingWindowMs: 3_600_000, resetWindowSeconds: 18_000, safetyMargin: 0.1
  } });
  assert.equal(result.estimated.quotaBudgetTokensSource, 'configured');
  assert.equal(result.estimated.remainingAfterCountedTokens, 16_700);
  assert.equal(result.estimated.remainingTokens, 15_000);
  assert.equal(result.estimated.remainingTokensReliable, true);
  assert.equal(result.estimated.remainingTokensMethod, 'configured_budget_conservative_minimum');
  assert.ok(result.uncertainty.includes('provider_and_counted_token_estimates_differ'));
});

for (const invalidPercent of [-10, 101]) {
  test(`rejects out-of-range provider percentage ${invalidPercent}`, () => {
    const result = account({
      status: {
        state: 'ok', source: 'provider_api_measured', usedPercent: invalidPercent,
        fetchedAt: '2026-08-10T19:59:00.000Z', resetAt: '2026-08-10T21:00:00.000Z',
        windowSeconds: 18_000, allowed: true, limitReached: false
      },
      config: {
        quotaBudgetUsd: null, quotaBudgetTokens: 20_000, staleAfterMs: 300_000,
        smoothingWindowMs: 3_600_000, resetWindowSeconds: 18_000, safetyMargin: 0.1
      }
    });
    assert.equal(result.state, 'error');
    assert.equal(result.measured.usedPercent, null);
    assert.equal(result.measured.remainingPercent, null);
    assert.equal(result.estimated.remainingAfterCountedTokens, 16_700);
    assert.equal(result.estimated.remainingTokens, 0);
    assert.equal(result.estimated.remainingTokensReliable, false);
    assert.equal(result.estimated.remainingTokensMethod, 'conservative_zero_fallback');
    assert.ok(result.estimated.remainingTokensReasons.includes('provider_percent_out_of_range'));
    assert.ok(result.estimated.remainingTokensReasons.includes('provider_percent_unavailable'));
    assert.ok(result.uncertainty.includes('provider_percent_out_of_range'));
  });
}

test('returns a conservative numeric fallback without a positive provider denominator', () => {
  const result = account({ status: {
    state: 'ok', source: 'provider_api_measured', usedPercent: 0,
    fetchedAt: '2026-08-10T19:59:00.000Z', resetAt: '2026-08-10T21:00:00.000Z',
    windowSeconds: 18_000, allowed: true, limitReached: false
  } });
  assert.equal(result.estimated.quotaBudgetTokens, null);
  assert.equal(result.estimated.remainingTokens, 0);
  assert.equal(result.estimated.remainingTokensReliable, false);
  assert.equal(result.estimated.remainingTokensMethod, 'conservative_zero_fallback');
  assert.ok(result.estimated.remainingTokensReasons.includes('conservative_zero_fallback'));
  assert.ok(result.uncertainty.includes('token_budget_needs_positive_provider_percent'));
});

test('returns a conservative numeric fallback without a known reset boundary', () => {
  const result = account({
    status: {
      state: 'ok', source: 'provider_api_measured', usedPercent: 25,
      fetchedAt: '2026-08-10T19:59:00.000Z', resetAt: null,
      windowSeconds: 18_000, allowed: true, limitReached: false
    },
    config: {
      quotaBudgetUsd: null, quotaBudgetTokens: 20_000, staleAfterMs: 300_000,
      smoothingWindowMs: 3_600_000, resetWindowSeconds: 18_000, safetyMargin: 0.1
    }
  });
  assert.equal(result.state, 'ok');
  assert.equal(result.estimated.remainingTokens, 0);
  assert.equal(result.estimated.remainingTokensReliable, false);
  assert.equal(result.estimated.remainingTokensMethod, 'conservative_zero_fallback');
  assert.ok(result.estimated.remainingTokensReasons.includes('reset_time_unavailable'));
  assert.ok(result.estimated.remainingTokensReasons.includes('conservative_zero_fallback'));
});

test('returns an explicitly unreliable estimate from incomplete receipt coverage', () => {
  const result = account({ receiptCoverage: {
    complete: false, completeFrom: '2026-08-10T19:45:00.000Z', truncated: true
  } });
  assert.equal(result.counted.complete, false);
  assert.equal(result.counted.truncated, true);
  assert.equal(result.estimated.quotaBudgetTokens, 13_200);
  assert.equal(result.estimated.quotaBudgetTokensSource, 'inferred_from_partial_counted_tokens_and_provider_percent');
  assert.equal(result.estimated.remainingTokens, 9900);
  assert.equal(result.estimated.remainingTokensReliable, false);
  assert.ok(result.estimated.remainingTokensReasons.includes('counted_receipts_incomplete'));
  assert.ok(result.uncertainty.includes('token_budget_inferred_from_partial_receipts'));
});

test('keeps configured-budget token target unavailable with incomplete receipts', () => {
  const partial = account({
    receiptCoverage: { complete: false, truncated: true },
    config: {
      quotaBudgetUsd: null, quotaBudgetTokens: 20_000, staleAfterMs: 300_000,
      smoothingWindowMs: 3_600_000, resetWindowSeconds: 18_000, safetyMargin: 0.1
    }
  });
  const aggregate = aggregateQuota([partial], { nowMs, safetyMargin: 0.1 });
  assert.equal(partial.estimated.remainingTokens, 15_000);
  assert.equal(partial.estimated.targetBurnRateTokensPerSecond, null);
  assert.equal(aggregate.targetBurnRateTokensPerSecond, null);
  assert.equal(aggregate.tokenTargetAccountCount, 0);
  assert.equal(aggregate.tokenVelocityAccountCount, 1);
});

test('keeps aggregate token target unavailable for a partial inferred estimate', () => {
  const partial = account({ receiptCoverage: {
    complete: false, completeFrom: '2026-08-10T19:45:00.000Z', truncated: true
  } });
  const aggregate = aggregateQuota([partial], { nowMs, safetyMargin: 0.1 });
  assert.equal(partial.estimated.remainingTokens, 9900);
  assert.equal(partial.estimated.targetBurnRateTokensPerSecond, null);
  assert.equal(aggregate.remainingTokens, 9900);
  assert.equal(aggregate.targetBurnRateTokensPerSecond, null);
  assert.equal(aggregate.tokenEstimateAccountCount, 1);
  assert.equal(aggregate.tokenTargetAccountCount, 0);
  assert.equal(aggregate.tokenVelocityAccountCount, 1);
});

test('suppresses aggregate token guidance when velocity includes an account without a target', () => {
  const complete = account({
    receipts: [
      { timestamp: '2026-08-10T19:30:00.000Z', inputTokens: 1000, outputTokens: 100, costUsd: 0 },
      { timestamp: '2026-08-10T19:50:00.000Z', inputTokens: 2000, outputTokens: 200, costUsd: 0 }
    ],
    config: {
      quotaBudgetUsd: null, quotaBudgetTokens: 20_000, staleAfterMs: 300_000,
      smoothingWindowMs: 3_600_000, resetWindowSeconds: 18_000, safetyMargin: 0.1
    }
  });
  const partial = account({
    account: { email: 'b@example.test', provider: 'codex' },
    receipts: [
      { timestamp: '2026-08-10T19:30:00.000Z', inputTokens: 100_000, outputTokens: 10_000, costUsd: 0 },
      { timestamp: '2026-08-10T19:50:00.000Z', inputTokens: 200_000, outputTokens: 20_000, costUsd: 0 }
    ],
    receiptCoverage: { complete: false, truncated: true },
    config: {
      quotaBudgetUsd: null, quotaBudgetTokens: null, staleAfterMs: 300_000,
      smoothingWindowMs: 3_600_000, resetWindowSeconds: 18_000, safetyMargin: 0.1
    }
  });
  const aggregate = aggregateQuota([complete, partial], { nowMs, safetyMargin: 0.1 });
  assert.equal(complete.estimated.signal, 'speed_up');
  assert.equal(partial.estimated.targetBurnRateTokensPerSecond, null);
  assert.equal(aggregate.targetBurnRateTokensPerSecond, complete.estimated.targetBurnRateTokensPerSecond);
  assert.ok(aggregate.actualVelocityTokensPerSecond > aggregate.targetBurnRateTokensPerSecond);
  assert.equal(aggregate.tokenTargetAccountCount, 1);
  assert.equal(aggregate.tokenVelocityAccountCount, 2);
  assert.equal(aggregate.signal, 'unavailable');
  assert.equal(aggregate.signalSource, 'unavailable');
});

test('suppresses generic USD guidance when token contributor subsets differ', () => {
  const config = {
    quotaBudgetUsd: 100, quotaBudgetTokens: 20_000, staleAfterMs: 300_000,
    smoothingWindowMs: 3_600_000, resetWindowSeconds: 18_000, safetyMargin: 0.1
  };
  const complete = account({ config });
  const partial = account({
    account: { email: 'b@example.test', provider: 'codex' },
    receiptCoverage: { complete: false, truncated: true },
    config
  });
  const aggregate = aggregateQuota([complete, partial], { nowMs, safetyMargin: 0.1 });
  assert.notEqual(aggregate.targetBurnRateUsdPerSecond, null);
  assert.notEqual(aggregate.actualVelocityUsdPerSecond, null);
  assert.equal(aggregate.tokenTargetAccountCount, 1);
  assert.equal(aggregate.tokenVelocityAccountCount, 2);
  assert.equal(aggregate.signal, 'unavailable');
  assert.equal(aggregate.signalSource, 'unavailable');
});

test('suppresses USD guidance when one target account lacks priced velocity', () => {
  const config = {
    quotaBudgetUsd: 100, quotaBudgetTokens: 20_000, staleAfterMs: 300_000,
    smoothingWindowMs: 3_600_000, resetWindowSeconds: 18_000, safetyMargin: 0.1
  };
  const priced = account({ config });
  const unpriced = account({
    account: { email: 'b@example.test', provider: 'codex' },
    receipts: [
      { timestamp: '2026-08-10T19:30:00.000Z', inputTokens: 1000, outputTokens: 100, costUsd: 0 },
      { timestamp: '2026-08-10T19:50:00.000Z', inputTokens: 2000, outputTokens: 200, costUsd: 0 }
    ],
    config
  });
  const aggregate = aggregateQuota([priced, unpriced], { nowMs, safetyMargin: 0.1 });
  assert.notEqual(aggregate.targetBurnRateUsdPerSecond, null);
  assert.equal(unpriced.estimated.actualVelocityUsdPerSecond, null);
  assert.equal(aggregate.actualVelocityUsdPerSecond, priced.estimated.actualVelocityUsdPerSecond);
  assert.equal(aggregate.dollarTargetAccountCount, 2);
  assert.equal(aggregate.dollarVelocityAccountCount, 1);
  assert.equal(aggregate.tokenTargetAccountCount, 2);
  assert.equal(aggregate.tokenVelocityAccountCount, 2);
  assert.equal(aggregate.signal, 'unavailable');
  assert.equal(aggregate.signalSource, 'unavailable');
});

test('counts velocity from an otherwise-ok account with a fallback token estimate', () => {
  const fallback = account({ status: {
    state: 'ok', source: 'provider_api_measured', usedPercent: 0,
    fetchedAt: '2026-08-10T19:59:00.000Z', resetAt: '2026-08-10T21:00:00.000Z',
    windowSeconds: 18_000, allowed: true, limitReached: false
  }, config: {
    quotaBudgetUsd: null, quotaBudgetTokens: null, staleAfterMs: 300_000,
    smoothingWindowMs: 3_600_000, resetWindowSeconds: 18_000, safetyMargin: 0.1
  } });
  const aggregate = aggregateQuota([fallback], { nowMs, safetyMargin: 0.1 });
  assert.equal(fallback.estimated.remainingTokensMethod, 'conservative_zero_fallback');
  assert.equal(aggregate.targetBurnRateTokensPerSecond, null);
  assert.equal(aggregate.tokenTargetAccountCount, 0);
  assert.equal(aggregate.actualVelocityTokensPerSecond, fallback.estimated.actualVelocityTokensPerSecond);
  assert.equal(aggregate.tokenVelocityAccountCount, 1);
  assert.equal(aggregate.signal, 'unavailable');
});

test('suppresses token guidance when a target account lacks velocity samples', () => {
  const config = {
    quotaBudgetUsd: null, quotaBudgetTokens: 20_000, staleAfterMs: 300_000,
    smoothingWindowMs: 3_600_000, resetWindowSeconds: 18_000, safetyMargin: 0.1
  };
  const withVelocity = account({
    receipts: [
      { timestamp: '2026-08-10T19:30:00.000Z', inputTokens: 1000, outputTokens: 100, costUsd: 0 },
      { timestamp: '2026-08-10T19:50:00.000Z', inputTokens: 2000, outputTokens: 200, costUsd: 0 }
    ],
    config
  });
  const withoutVelocity = account({
    account: { email: 'b@example.test', provider: 'codex' },
    receipts: [
      { timestamp: '2026-08-10T19:50:00.000Z', inputTokens: 2000, outputTokens: 200, costUsd: 0 }
    ],
    config
  });
  const aggregate = aggregateQuota([withVelocity, withoutVelocity], { nowMs, safetyMargin: 0.1 });
  assert.notEqual(withVelocity.estimated.targetBurnRateTokensPerSecond, null);
  assert.notEqual(withoutVelocity.estimated.targetBurnRateTokensPerSecond, null);
  assert.equal(withoutVelocity.estimated.actualVelocityTokensPerSecond, null);
  assert.equal(aggregate.tokenTargetAccountCount, 2);
  assert.equal(aggregate.tokenVelocityAccountCount, 1);
  assert.equal(aggregate.signal, 'unavailable');
  assert.equal(aggregate.signalSource, 'unavailable');
});

test('fails closed when the provider reports that an account is blocked', () => {
  const result = account({ status: {
    state: 'ok', source: 'provider_api_measured', usedPercent: 0,
    fetchedAt: '2026-08-10T19:59:00.000Z', resetAt: '2026-08-10T21:00:00.000Z',
    windowSeconds: 18_000, allowed: false, limitReached: true
  } });
  assert.equal(result.state, 'blocked');
  assert.equal(result.estimated.remainingEquivalentQuotaUsd, null);
  assert.equal(result.estimated.remainingTokens, 0);
  assert.equal(result.estimated.remainingTokensReliable, false);
  assert.ok(result.estimated.remainingTokensReasons.includes('account_state_blocked'));
  assert.equal(result.estimated.signal, 'unavailable');
});

test('fails closed after the measured provider reset time has elapsed', () => {
  const result = account({ status: {
    state: 'ok', source: 'provider_api_measured', usedPercent: 25,
    fetchedAt: '2026-08-10T19:59:00.000Z', resetAt: '2026-08-10T19:59:30.000Z',
    windowSeconds: 18_000, allowed: true, limitReached: false
  } });
  assert.equal(result.state, 'reset_due');
  assert.equal(result.estimated.remainingEquivalentQuotaUsd, null);
  assert.equal(result.estimated.remainingTokens, 0);
  assert.equal(result.estimated.remainingTokensReliable, false);
  assert.ok(result.estimated.remainingTokensReasons.includes('account_state_reset_due'));
  assert.equal(result.estimated.signal, 'unavailable');
});

test('fails closed when provider data is stale', () => {
  const result = account({
    status: {
      state: 'ok', source: 'provider_api_measured', usedPercent: 25,
      fetchedAt: '2026-08-10T19:00:00.000Z', resetAt: '2026-08-10T21:00:00.000Z', windowSeconds: 18_000
    }
  });
  assert.equal(result.state, 'stale');
  assert.equal(result.estimated.remainingEquivalentQuotaUsd, null);
  assert.equal(result.estimated.remainingTokens, 0);
  assert.equal(result.estimated.remainingTokensReliable, false);
  assert.ok(result.estimated.remainingTokensReasons.includes('account_state_stale'));
  assert.equal(result.estimated.targetBurnRateUsdPerSecond, null);
  assert.equal(result.estimated.targetBurnRateTokensPerSecond, null);
  assert.equal(result.estimated.signal, 'unavailable');
});

test('aggregates only usable accounts and marks partial data degraded', () => {
  const healthy = account();
  const stale = account({
    account: { email: 'b@example.test', provider: 'codex' },
    status: { state: 'error', fetchedAt: '2026-08-10T19:59:00.000Z' }
  });
  const aggregate = aggregateQuota([healthy, stale], { nowMs, safetyMargin: 0.1 });
  assert.equal(aggregate.state, 'degraded');
  assert.equal(aggregate.accountCount, 2);
  assert.equal(aggregate.usableAccountCount, 1);
  assert.equal(aggregate.remainingEquivalentQuotaUsd, 75);
  assert.equal(aggregate.remainingTokens, 9900);
  assert.equal(aggregate.remainingTokensReliable, false);
  assert.equal(aggregate.tokenEstimateAccountCount, 1);
  assert.equal(aggregate.numericTokenEstimateAccountCount, 2);
  assert.equal(aggregate.fallbackTokenEstimateAccountCount, 1);
  assert.equal(aggregate.reliableTokenEstimateAccountCount, 0);
  assert.ok(aggregate.remainingTokensReasons.includes('account_state_error'));
  assert.match(aggregate.remainingTokensNote, /2\/2 account estimate\(s\)/);
});

test('returns a numeric unreliable aggregate when every account needs a fallback', () => {
  const unavailable = account({
    status: { state: 'error', fetchedAt: '2026-08-10T19:59:00.000Z' }
  });
  const aggregate = aggregateQuota([unavailable], { nowMs, safetyMargin: 0.1 });
  assert.equal(aggregate.state, 'unavailable');
  assert.equal(aggregate.remainingTokens, 0);
  assert.equal(aggregate.remainingTokensReliable, false);
  assert.equal(aggregate.tokenEstimateAccountCount, 0);
  assert.equal(aggregate.numericTokenEstimateAccountCount, 1);
  assert.equal(aggregate.fallbackTokenEstimateAccountCount, 1);
});

test('returns a numeric unreliable empty aggregate', () => {
  const aggregate = aggregateQuota([], { nowMs, safetyMargin: 0.1 });
  assert.equal(aggregate.remainingTokens, 0);
  assert.equal(aggregate.remainingTokensReliable, false);
  assert.equal(aggregate.numericTokenEstimateAccountCount, 0);
  assert.match(aggregate.remainingTokensNote, /no accounts/i);
  assert.deepEqual(aggregate.remainingTokensReasons, ['no_accounts_available', 'conservative_zero_fallback']);
});

test('does not invent aggregate velocity before two receipt samples exist', () => {
  const result = account({ receipts: [{ timestamp: '2026-08-10T19:50:00.000Z', inputTokens: 2000, outputTokens: 200, costUsd: 4 }] });
  const aggregate = aggregateQuota([result], { nowMs, safetyMargin: 0.1 });
  assert.equal(aggregate.actualVelocityUsdPerSecond, null);
  assert.equal(aggregate.signal, 'unavailable');
});

test('retention enforces both age and count bounds', () => {
  const entries = [
    { at: '2026-08-10T19:00:00.000Z', id: 'newer' },
    { at: '2026-08-10T18:00:00.000Z', id: 'older' },
    { at: '2026-07-01T00:00:00.000Z', id: 'expired' }
  ];
  assert.deepEqual(retainHistory(entries, { nowMs, retentionDays: 30, maxEntries: 1 }).map(entry => entry.id), ['newer']);
});

test('quota planning excludes disabled or unidentified accounts from routable capacity', () => {
  assert.equal(isRoutableAccount({ email: 'active@example.com', enabled: true }), true);
  assert.equal(isRoutableAccount({ email: 'default@example.com' }), true);
  assert.equal(isRoutableAccount({ email: 'disabled@example.com', enabled: false }), false);
  assert.equal(isRoutableAccount({ enabled: true }), false);
});
