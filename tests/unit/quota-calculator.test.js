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
  assert.ok(result.uncertainty.includes('provider_and_counted_token_estimates_differ'));
});

test('does not infer tokens left without a positive provider denominator', () => {
  const result = account({ status: {
    state: 'ok', source: 'provider_api_measured', usedPercent: 0,
    fetchedAt: '2026-08-10T19:59:00.000Z', resetAt: '2026-08-10T21:00:00.000Z',
    windowSeconds: 18_000, allowed: true, limitReached: false
  } });
  assert.equal(result.estimated.quotaBudgetTokens, null);
  assert.equal(result.estimated.remainingTokens, null);
  assert.ok(result.uncertainty.includes('token_budget_needs_positive_provider_percent'));
});

test('does not infer tokens left from incomplete receipt coverage', () => {
  const result = account({ receiptCoverage: {
    complete: false, completeFrom: '2026-08-10T19:45:00.000Z', truncated: true
  } });
  assert.equal(result.counted.complete, false);
  assert.equal(result.counted.truncated, true);
  assert.equal(result.estimated.quotaBudgetTokens, null);
  assert.equal(result.estimated.remainingTokens, null);
  assert.ok(result.uncertainty.includes('token_budget_needs_complete_receipts'));
});

test('fails closed when the provider reports that an account is blocked', () => {
  const result = account({ status: {
    state: 'ok', source: 'provider_api_measured', usedPercent: 0,
    fetchedAt: '2026-08-10T19:59:00.000Z', resetAt: '2026-08-10T21:00:00.000Z',
    windowSeconds: 18_000, allowed: false, limitReached: true
  } });
  assert.equal(result.state, 'blocked');
  assert.equal(result.estimated.remainingEquivalentQuotaUsd, null);
  assert.equal(result.estimated.remainingTokens, null);
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
  assert.equal(result.estimated.remainingTokens, null);
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
  assert.equal(result.estimated.remainingTokens, null);
  assert.equal(result.estimated.targetBurnRateUsdPerSecond, null);
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
  assert.equal(aggregate.tokenEstimateAccountCount, 1);
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
