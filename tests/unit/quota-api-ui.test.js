import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('quota API returns one credential-free versioned schema and accepts safe config', async t => {
  const configDir = mkdtempSync(join(tmpdir(), 'cligate-quota-api-'));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  process.env.HOME = configDir;
  process.env.USERPROFILE = configDir;
  process.env.CLIGATE_CONFIG_DIR = configDir;
  process.env.CLAUDE_CONFIG_PATH = join(configDir, '.claude');
  process.env.CLIGATE_CLAUDE_CREDENTIALS_FILE = join(configDir, '.claude', '.credentials.json');
  process.env.CLIGATE_CODEX_AUTH_FILE = join(configDir, '.codex', 'auth.json');
  const { startServer } = await import('../../src/server.js');
  const server = startServer({ port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const quotaResponse = await fetch(`${baseUrl}/api/quota`);
  assert.equal(quotaResponse.status, 200);
  const quota = await quotaResponse.json();
  assert.equal(quota.schemaVersion, 1);
  assert.equal(quota.state, 'unavailable');
  assert.deepEqual(quota.accounts, []);
  assert.equal(JSON.stringify(quota).match(/accessToken|refreshToken|Authorization/), null);

  const configResponse = await fetch(`${baseUrl}/api/quota/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ safetyMargin: 0.2, accessToken: 'must-not-survive' })
  });
  assert.equal(configResponse.status, 200);
  const config = (await configResponse.json()).config;
  assert.equal(config.safetyMargin, 0.2);
  assert.equal('accessToken' in config, false);
});

test('web UI and command help expose quota planning', () => {
  const moduleSource = readFileSync(new URL('../../public/js/modules/usage-pricing-page.js', import.meta.url), 'utf8');
  const viewSource = readFileSync(new URL('../../public/partials/views/usage.html', import.meta.url), 'utf8');
  assert.match(moduleSource, /api\/quota/);
  assert.match(moduleSource, /quotaSignalLabel/);
  assert.match(viewSource, /remainingEquivalentQuotaUsd/);
  assert.match(viewSource, /actualVelocityUsdPerSecond/);
  const help = execFileSync(process.execPath, ['bin/cli.js', '--help'], { encoding: 'utf8' });
  assert.match(help, /quota --refresh/);
  assert.match(help, /quota --json/);
});

test('both native Codex response routes plumb measured usage into receipts', () => {
  for (const relativePath of ['../../src/routes/responses-route.js', '../../src/routes/codex-route.js']) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /createCodexUsageCollector\(\)/);
    assert.match(source, /extractCodexUsage\(JSON\.parse\(responseBody\)\)/);
    assert.match(source, /recordRequest\(\{[^}]*cacheReadTokens[^}]*cost/s);
  }
});
