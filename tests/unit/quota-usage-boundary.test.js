import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('quota receipt ledger rejects legacy boundary overlap and splits registered reset buckets', async t => {
  const configDir = mkdtempSync(join(tmpdir(), 'cligate-quota-boundary-'));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  process.env.HOME = configDir;
  process.env.USERPROFILE = configDir;
  process.env.CLIGATE_CONFIG_DIR = configDir;
  process.env.CLAUDE_CONFIG_PATH = join(configDir, '.claude');
  process.env.CLIGATE_CLAUDE_CREDENTIALS_FILE = join(configDir, '.claude', '.credentials.json');
  process.env.CLIGATE_CODEX_AUTH_FILE = join(configDir, '.codex', 'auth.json');
  const minuteMs = Math.floor(Date.now() / 60_000) * 60_000;
  const legacyBoundaryMs = minuteMs + 30_000;
  writeFileSync(join(configDir, 'usage-history.json'), JSON.stringify([
    {
      timestamp: new Date(legacyBoundaryMs + 1000).toISOString(), provider: 'chatgpt-pool',
      keyId: 'a@example.test', model: 'gpt-test', inputTokens: 20, outputTokens: 10, success: true
    },
    {
      timestamp: new Date(legacyBoundaryMs - 1000).toISOString(), provider: 'chatgpt-pool',
      keyId: 'a@example.test', model: 'gpt-test', inputTokens: 200, outputTokens: 100, success: true
    }
  ]));
  const { getQuotaUsageReceipts, recordRequest, setQuotaUsageWindow } = await import('../../src/usage-tracker.js');
  const legacy = getQuotaUsageReceipts({
    provider: 'chatgpt-pool', keyId: 'a@example.test',
    fromMs: legacyBoundaryMs, throughMs: legacyBoundaryMs + 5000
  });
  assert.equal(legacy.coverage.complete, false);
  assert.equal(legacy.receipts.length, 0);
  const nextBoundaryMs = minuteMs + 150_000;
  assert.equal(setQuotaUsageWindow({
    provider: 'chatgpt-pool', keyId: 'a@example.test',
    resetAt: new Date(nextBoundaryMs).toISOString(), windowSeconds: 3600
  }), true);
  recordRequest({
    provider: 'chatgpt-pool', keyId: 'a@example.test', model: 'gpt-test',
    inputTokens: 2000, outputTokens: 1000, success: true,
    timestamp: new Date(nextBoundaryMs - 1000).toISOString()
  });
  recordRequest({
    provider: 'chatgpt-pool', keyId: 'a@example.test', model: 'gpt-test',
    inputTokens: 200, outputTokens: 100, success: true,
    timestamp: new Date(nextBoundaryMs + 1000).toISOString()
  });
  const split = getQuotaUsageReceipts({
    provider: 'chatgpt-pool', keyId: 'a@example.test',
    fromMs: nextBoundaryMs, throughMs: nextBoundaryMs + 5000
  });
  assert.equal(split.coverage.complete, true);
  assert.equal(split.receipts.length, 1);
  assert.equal(split.receipts[0].inputTokens + split.receipts[0].outputTokens, 300);
});
