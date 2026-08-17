import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuotaStore } from '../../src/quota/quota-store.js';

test('quota store persists only normalized configuration and bounded observations', t => {
  const configDir = mkdtempSync(join(tmpdir(), 'cligate-quota-store-'));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const nowMs = Date.parse('2026-08-10T20:00:00.000Z');
  const store = createQuotaStore({ configDir, now: () => nowMs });
  const config = store.setConfig({
    pollingIntervalMs: 20_000,
    accessToken: 'must-not-survive',
    providers: { codex: { quotaBudgetUsd: 90, quotaBudgetTokens: 2_000_000, secret: 'must-not-survive' } }
  });
  assert.equal(config.pollingIntervalMs, 20_000);
  assert.equal(config.providers.codex.quotaBudgetUsd, 90);
  assert.equal(config.providers.codex.quotaBudgetTokens, 2_000_000);
  assert.equal(config.forecastWatch.windowMs, 3_600_000);
  assert.equal(config.forecastWatch.minPace, 0.70);
  assert.equal(config.forecastWatch.maxPace, 0.95);
  assert.equal(config.forecastWatch.managerGuidePath, 'docs/codex/cligate-quota-forecast-watch.md');
  const legacyConfigDir = mkdtempSync(join(tmpdir(), 'cligate-quota-legacy-config-'));
  t.after(() => rmSync(legacyConfigDir, { recursive: true, force: true }));
  writeFileSync(join(legacyConfigDir, 'quota-config.json'), JSON.stringify({
    forecastWatch: { managerGuidePath: 'docs/codex/cligate-quota-forecast-watch.draft.md' }
  }));
  assert.equal(
    createQuotaStore({ configDir: legacyConfigDir }).getConfig().forecastWatch.managerGuidePath,
    'docs/codex/cligate-quota-forecast-watch.md'
  );
  assert.equal('accessToken' in config, false);
  assert.equal('secret' in config.providers.codex, false);
  store.setForecastWatchState({
    lastNotification: {
      key: 'too_slow:tokens:2026-08-10T21:00:00.000Z',
      notifiedAt: '2026-08-10T20:00:00.000Z'
    }
  });
  assert.equal(store.getForecastWatchState().lastNotification.key, 'too_slow:tokens:2026-08-10T21:00:00.000Z');
  store.addObservation({ at: '2026-08-10T19:00:00.000Z', account: 'a@example.test', usedPercent: 20 });
  store.addObservation({ at: '2026-01-01T00:00:00.000Z', account: 'expired@example.test', usedPercent: 90 });
  assert.equal(store.getHistory().length, 1);
  const persisted = readFileSync(join(configDir, 'quota-config.json'), 'utf8');
  assert.equal(persisted.includes('must-not-survive'), false);
  assert.equal(statSync(join(configDir, 'quota-config.json')).mode & 0o077, 0);
  assert.equal(statSync(join(configDir, 'quota-forecast-watch-state.json')).mode & 0o077, 0);
});
