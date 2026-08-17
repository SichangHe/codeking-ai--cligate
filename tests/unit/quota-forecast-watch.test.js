import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuotaForecast } from '../../src/quota/quota-forecast-watch.js';

const nowMs = Date.parse('2026-08-17T16:00:00.000Z');

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    state: 'ok',
    aggregate: {
      state: 'ok',
      remainingTokens: 1_000_000,
      actualVelocityTokensPerSecond: 120,
      nextResetAt: '2026-08-17T18:00:00.000Z',
      signalSource: 'tokens',
      ...overrides
    },
    accounts: [{
      measured: { resetAt: '2026-08-17T18:00:00.000Z' },
      estimated: {
        targetBurnRateTokensPerSecond: 100,
        actualVelocityTokensPerSecond: 120
      }
    }]
  };
}

test('forecast watcher flags too-fast pace above the target band', () => {
  const result = buildQuotaForecast(snapshot({ actualVelocityTokensPerSecond: 140 }), {
    nowMs,
    config: { minPace: 0.70, maxPace: 0.95 }
  });
  assert.equal(result.experimental, true);
  assert.equal(result.signal, 'too_fast');
  assert.equal(result.signalSource, 'tokens');
  assert.equal(Math.round(result.forecast.paceRatio * 100), 101);
  assert.equal(result.notification.shouldNotify, true);
  assert.equal(result.notification.reason, 'pace_outside_target');
});

test('forecast watcher suppresses only repeated same-type notifications', () => {
  const first = buildQuotaForecast(snapshot({ actualVelocityTokensPerSecond: 50 }), {
    nowMs,
    config: { minPace: 0.70, maxPace: 0.95 }
  });
  assert.equal(first.signal, 'too_slow');
  assert.equal(first.notification.shouldNotify, true);
  assert.equal(first.notification.reason, 'pace_outside_target');

  const repeated = buildQuotaForecast(snapshot({ actualVelocityTokensPerSecond: 50 }), {
    nowMs: nowMs + 30 * 60 * 1000,
    config: { minPace: 0.70, maxPace: 0.95, debounceMs: 60 * 60 * 1000 },
    previousNotification: {
      type: first.notification.type,
      notifiedAt: new Date(nowMs).toISOString()
    }
  });
  assert.equal(repeated.notification.shouldNotify, false);
  assert.equal(repeated.notification.sameTypeSuppressed, true);
  assert.equal(repeated.notification.duplicateSuppressed, true);
  assert.equal(repeated.notification.key, first.notification.key);
  assert.equal(repeated.notification.reason, 'debounced_duplicate');

  const changedType = buildQuotaForecast(snapshot({ actualVelocityTokensPerSecond: 220 }), {
    nowMs: nowMs + 30 * 60 * 1000,
    config: { minPace: 0.70, maxPace: 0.95, debounceMs: 60 * 60 * 1000 },
    previousNotification: {
      type: first.notification.type,
      notifiedAt: new Date(nowMs).toISOString()
    }
  });
  assert.equal(changedType.signal, 'too_fast');
  assert.equal(changedType.notification.shouldNotify, true);
  assert.equal(changedType.notification.sameTypeSuppressed, false);

  const afterDebounce = buildQuotaForecast(snapshot({ actualVelocityTokensPerSecond: 50 }), {
    nowMs: nowMs + 61 * 60 * 1000,
    config: { minPace: 0.70, maxPace: 0.95, debounceMs: 60 * 60 * 1000 },
    previousNotification: {
      type: first.notification.type,
      notifiedAt: new Date(nowMs).toISOString()
    }
  });
  assert.equal(afterDebounce.notification.shouldNotify, true);
});

test('forecast watcher suppresses on-track and unavailable notifications', () => {
  const onTrack = buildQuotaForecast(snapshot({ actualVelocityTokensPerSecond: 110 }), {
    nowMs,
    config: { minPace: 0.70, maxPace: 0.95 }
  });
  assert.equal(onTrack.signal, 'on_track');
  assert.equal(onTrack.notification.shouldNotify, false);

  const unavailable = buildQuotaForecast(snapshot({ nextResetAt: null }), { nowMs });
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.signal, 'unavailable');
  assert.equal(unavailable.notification.shouldNotify, false);
});

test('forecast watcher requires comparable aggregate token guidance', () => {
  const incomparable = buildQuotaForecast(snapshot({
    signalSource: 'unavailable',
    actualVelocityTokensPerSecond: 140
  }), { nowMs });
  assert.equal(incomparable.signal, 'unavailable');
  assert.equal(incomparable.signalSource, 'unavailable');
  assert.equal(incomparable.notification.shouldNotify, false);
});

test('forecast watcher restricts windows to one or two hours', () => {
  const defaultWindow = buildQuotaForecast(snapshot(), {
    nowMs,
    config: { windowMs: 90 * 60 * 1000 }
  });
  assert.equal(defaultWindow.windowMs, 60 * 60 * 1000);

  const twoHour = buildQuotaForecast(snapshot(), {
    nowMs,
    config: { windowMs: 2 * 60 * 60 * 1000 }
  });
  assert.equal(twoHour.windowMs, 2 * 60 * 60 * 1000);
});

test('forecast watcher suppresses mixed-reset contributor aggregates', () => {
  const mixedResets = buildQuotaForecast({
    ...snapshot(),
    accounts: [
      {
        measured: { resetAt: '2026-08-17T18:00:00.000Z' },
        estimated: { targetBurnRateTokensPerSecond: 100, actualVelocityTokensPerSecond: 120 }
      },
      {
        measured: { resetAt: '2026-08-18T18:00:00.000Z' },
        estimated: { targetBurnRateTokensPerSecond: 100, actualVelocityTokensPerSecond: 120 }
      }
    ]
  }, { nowMs });
  assert.equal(mixedResets.signal, 'unavailable');
  assert.equal(mixedResets.notification.shouldNotify, false);
});
