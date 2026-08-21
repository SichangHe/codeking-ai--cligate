import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { AccountRotator } from '../../src/account-rotation/index.js';

async function importFresh(modulePath, label) {
  return import(`${modulePath}?${label}-${Date.now()}-${Math.random()}`);
}

test('recognizes Codex ChatGPT account model-unavailable errors narrowly in both Codex routes', async () => {
  const { isCodexChatGptModelUnavailableError: isCodexModelUnavailableError } = await importFresh(
    '../../src/routes/codex-route.js',
    'codex-predicate'
  );
  const { isCodexChatGptModelUnavailableError: isResponsesModelUnavailableError } = await importFresh(
    '../../src/routes/responses-route.js',
    'responses-predicate'
  );

  assert.equal(
    isCodexModelUnavailableError(
      "{\"detail\":\"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.\"}"
    ),
    true
  );
  assert.equal(
    isResponsesModelUnavailableError(
      'The gpt-5.6-sol model is not supported when using Codex with a ChatGPT account.'
    ),
    true
  );
  assert.equal(isCodexModelUnavailableError('Selected model is at capacity. Please try a different model.'), false);
  assert.equal(isResponsesModelUnavailableError('HTTP 403 forbidden'), false);
  assert.equal(
    isCodexModelUnavailableError('The requested feature is not supported when using Codex with a ChatGPT account.'),
    false
  );
  assert.equal(
    isResponsesModelUnavailableError('This endpoint is not supported when using Codex with a ChatGPT account.'),
    false
  );
  assert.equal(
    isCodexModelUnavailableError('Model selection is not supported when using Codex with a ChatGPT account.'),
    false
  );
  assert.equal(
    isResponsesModelUnavailableError('The endpoint model is not supported when using Codex with a ChatGPT account.'),
    false
  );
});

test('account rotator prefers fresh reloads over cached loads before selecting', () => {
  let staleAccounts = [
    { email: 'cooling@example.test', enabled: true },
    { email: 'fresh@example.test', enabled: true }
  ];
  const resetTime = Date.now() + 60_000;
  const persistedAccounts = [
    {
      email: 'cooling@example.test',
      enabled: true,
      modelRateLimits: { 'gpt-5.6-sol': { isRateLimited: true, resetTime } }
    },
    { email: 'fresh@example.test', enabled: true }
  ];
  const manager = {
    listAccounts() {
      return { accounts: staleAccounts };
    },
    loadAccounts() {
      return { accounts: staleAccounts };
    },
    reloadAccounts() {
      staleAccounts = persistedAccounts;
      return { accounts: staleAccounts };
    },
    save() {
      staleAccounts = persistedAccounts;
    }
  };

  const rotator = new AccountRotator(manager, 'sequential');
  const selected = rotator.selectAccount('gpt-5.6-sol');
  assert.equal(selected.account.email, 'fresh@example.test');

  const selectedOtherModel = rotator.selectAccount('gpt-5.5');
  assert.equal(selectedOtherModel.account.email, 'cooling@example.test');
});

test('assigned-route cooldown checks reload persisted account state from disk', t => {
  const configDir = mkdtempSync(join(tmpdir(), 'cligate-model-unavailable-'));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));

  writeFileSync(join(configDir, 'accounts.json'), JSON.stringify({
    version: 1,
    activeAccount: null,
    accounts: [{ email: 'cooling@example.test', enabled: true }]
  }));

  const script = `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { getChatGptModelCooldownMs as codexCooldown } from './src/routes/codex-route.js';
    import { getChatGptModelCooldownMs as responsesCooldown } from './src/routes/responses-route.js';

    assert.equal(codexCooldown('cooling@example.test', 'gpt-5.6-sol'), 0);
    assert.equal(responsesCooldown('cooling@example.test', 'gpt-5.6-sol'), 0);

    writeFileSync(join(process.env.CLIGATE_CONFIG_DIR, 'accounts.json'), JSON.stringify({
      version: 1,
      activeAccount: null,
      accounts: [{
        email: 'cooling@example.test',
        enabled: true,
        modelRateLimits: {
          'gpt-5.6-sol': {
            isRateLimited: true,
            resetTime: Date.now() + 60000
          }
        }
      }]
    }));

    assert.ok(codexCooldown('cooling@example.test', 'gpt-5.6-sol') > 0);
    assert.ok(responsesCooldown('cooling@example.test', 'gpt-5.6-sol') > 0);
    assert.equal(codexCooldown('cooling@example.test', 'gpt-5.5'), 0);
    assert.equal(responsesCooldown('cooling@example.test', 'gpt-5.5'), 0);
  `;

  execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, CLIGATE_CONFIG_DIR: configDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
});
