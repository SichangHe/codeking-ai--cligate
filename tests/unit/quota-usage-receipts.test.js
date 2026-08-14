import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('quota receipt ledger detects capped migration and excludes same-email non-ChatGPT traffic', async t => {
  const configDir = mkdtempSync(join(tmpdir(), 'cligate-quota-receipts-'));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  process.env.HOME = configDir;
  process.env.USERPROFILE = configDir;
  process.env.CLIGATE_CONFIG_DIR = configDir;
  process.env.CLAUDE_CONFIG_PATH = join(configDir, '.claude');
  process.env.CLIGATE_CLAUDE_CREDENTIALS_FILE = join(configDir, '.claude', '.credentials.json');
  process.env.CLIGATE_CODEX_AUTH_FILE = join(configDir, '.codex', 'auth.json');
  const nowMs = Date.now();
  const legacyHistory = Array.from({ length: 2000 }, (_, index) => ({
    timestamp: new Date(nowMs - index * 10).toISOString(), provider: 'other',
    keyId: 'shared@example.test', inputTokens: 1, outputTokens: 1, success: true
  }));
  writeFileSync(join(configDir, 'usage-history.json'), JSON.stringify(legacyHistory));
  const { getQuotaUsageReceipts, recordRequest } = await import('../../src/usage-tracker.js');
  const migrated = getQuotaUsageReceipts({
    provider: 'chatgpt-pool', keyId: 'shared@example.test',
    fromMs: nowMs - 60_000, throughMs: nowMs + 1000
  });
  assert.equal(migrated.coverage.complete, false);
  assert.equal(migrated.coverage.truncated, true);
  recordRequest({
    provider: 'chatgpt-pool', keyId: 'shared@example.test', model: 'gpt-test',
    inputTokens: 20, outputTokens: 10, success: true
  });
  recordRequest({
    provider: 'other', keyId: 'shared@example.test', model: 'gpt-test',
    inputTokens: 900, outputTokens: 100, success: true
  });
  const result = getQuotaUsageReceipts({
    provider: 'chatgpt-pool', keyId: 'shared@example.test',
    fromMs: nowMs - 60_000, throughMs: Date.now() + 1000
  });
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].inputTokens + result.receipts[0].outputTokens, 30);
  assert.equal(result.receipts[0].requests, 1);
});
