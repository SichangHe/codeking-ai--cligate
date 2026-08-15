import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUsagePricingPageModule } from '../../public/js/modules/usage-pricing-page.js';

function runFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('quota API returns one credential-free versioned schema and accepts safe config', async t => {
  const configDir = mkdtempSync(join(tmpdir(), 'cligate-quota-api-'));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  process.env.HOME = configDir;
  process.env.USERPROFILE = configDir;
  process.env.CLIGATE_CONFIG_DIR = configDir;
  process.env.CLAUDE_CONFIG_PATH = join(configDir, '.claude');
  process.env.CLIGATE_CLAUDE_CREDENTIALS_FILE = join(configDir, '.claude', '.credentials.json');
  process.env.CLIGATE_CODEX_AUTH_FILE = join(configDir, '.codex', 'auth.json');
  writeFileSync(join(configDir, 'accounts.json'), JSON.stringify({
    version: 1,
    activeAccount: null,
    accounts: [{ email: 'quota@example.test', enabled: true, planType: 'plus' }]
  }));
  const { startServer } = await import('../../src/server.js');
  const { buildUnavailableQuotaSummary } = await import('../../src/routes/quota-route.js');
  const fallback = buildUnavailableQuotaSummary();
  assert.equal(fallback.state, 'unavailable');
  assert.equal(fallback.aggregate.signal, 'unavailable');
  assert.equal(fallback.aggregate.signalSource, 'unavailable');
  assert.equal(fallback.aggregate.estimated.remainingTokens, 0);
  assert.equal(fallback.aggregate.estimated.reliable, false);
  assert.deepEqual(fallback.aggregate.estimated.reasons, [
    'quota_snapshot_unavailable', 'conservative_zero_fallback'
  ]);
  assert.equal(fallback.links.help, '/api/quota/help');
  const server = startServer({ port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const quotaResponse = await fetch(`${baseUrl}/api/quota`);
  assert.equal(quotaResponse.status, 200);
  const quota = await quotaResponse.json();
  assert.equal(quota.schemaVersion, 1);
  assert.equal(quota.state, 'unavailable');
  assert.equal(quota.accounts.length, 1);
  assert.equal(quota.accounts[0].estimated.remainingTokens, 0);
  assert.equal(quota.accounts[0].estimated.remainingTokensReliable, false);
  assert.equal(quota.accounts[0].estimated.remainingTokensMethod, 'conservative_zero_fallback');
  assert.equal(JSON.stringify(quota).match(/accessToken|refreshToken|Authorization/), null);

  const summaryResponse = await fetch(`${baseUrl}/api/quota/summary?refresh=true`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.aggregate.estimated.remainingTokens, 0);
  assert.equal(summary.aggregate.estimated.remainingEquivalentQuotaUsd, null);
  assert.equal(summary.aggregate.estimated.targetBurnRateUsdPerSecond, null);
  assert.equal(summary.aggregate.estimated.dollarTargetAccountCount, 0);
  assert.equal(summary.aggregate.estimated.targetBurnRateTokensPerSecond, null);
  assert.equal(summary.aggregate.estimated.tokenTargetAccountCount, 0);
  assert.equal(summary.aggregate.estimated.reliable, false);
  assert.equal(summary.aggregate.estimated.accountCount, 1);
  assert.equal(summary.aggregate.estimated.usableAccountCount, 0);
  assert.equal(summary.aggregate.estimated.fallbackAccountCount, 1);
  assert.equal(summary.aggregate.counted.actualVelocityTokensPerSecond, null);
  assert.equal(summary.aggregate.counted.tokenVelocityAccountCount, 0);
  assert.equal(summary.aggregate.counted.actualVelocityUsdPerSecond, null);
  assert.equal(summary.aggregate.counted.dollarVelocityAccountCount, 0);
  assert.equal(summary.aggregate.signalSource, 'unavailable');
  assert.equal(summary.accounts[0].measured.usedPercent, null);
  assert.equal(summary.accounts[0].measured.windowSeconds, 18_000);
  assert.equal(summary.accounts[0].counted.usedTokens, 0);
  assert.equal(summary.accounts[0].counted.complete, false);
  assert.equal(summary.accounts[0].counted.truncated, true);
  assert.equal(summary.accounts[0].estimated.remainingTokens, 0);
  assert.equal(summary.accounts[0].estimated.reliable, false);
  assert.match(summary.accounts[0].estimated.note, /may be unreliable/i);
  assert.ok(summary.accounts[0].estimated.reasons.includes('conservative_zero_fallback'));
  assert.equal(JSON.stringify(summary).match(/accessToken|refreshToken|Authorization/), null);

  const helpResponse = await fetch(`${baseUrl}/api/quota/help`);
  assert.equal(helpResponse.status, 200);
  const apiHelp = await helpResponse.json();
  assert.match(apiHelp.commands.summary, /curl -sS .*\/api\/quota\/summary\?refresh=true/);
  assert.match(apiHelp.commands.help, /curl -sS .*\/api\/quota\/help/);
  assert.match(apiHelp.fields.measured, /Provider-reported/);
  assert.match(apiHelp.fields.counted, /complete=false/);
  assert.match(apiHelp.fields.estimated, /Numeric remaining-token/);
  assert.deepEqual(apiHelp.planning.rules.map(rule => rule.signal), [
    'slow_down', 'on_track', 'speed_up', 'unavailable'
  ]);
  assert.match(apiHelp.planning.rules[0].action, /Prioritize important tasks/);
  assert.match(apiHelp.planning.rules[2].action, /useful deferred work/);
  assert.match(apiHelp.planning.guardrail, /signalSource/);
  assert.match(apiHelp.planning.guardrail, /contributor counts/);
  assert.doesNotMatch(JSON.stringify(apiHelp), /\bjq\b/i);
  const untrustedHostHelp = await fetch(`${baseUrl}/api/quota/help`, {
    headers: { host: "bad.example'; echo injected; '" }
  }).then(response => response.json());
  assert.match(untrustedHostHelp.commands.summary, /^curl -sS 'http:\/\/127\.0\.0\.1:\d+\//);
  assert.doesNotMatch(untrustedHostHelp.commands.summary, /injected/);

  const cli = await runFile(process.execPath, [
    fileURLToPath(new URL('../../src/cli/quota.js', import.meta.url))
  ], {
    env: { ...process.env, CLIGATE_URL: baseUrl },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /estimated left 0 \(unreliable\)/);
  assert.match(cli.stdout, /token target unavailable \(0 accounts\) \| actual unavailable \(0 accounts\)/);
  assert.match(cli.stdout, /remaining unavailable \| target unavailable \(0 accounts\) \| actual unavailable \(0 accounts\)/);
  assert.match(cli.stdout, /quota@example\.test: provider usage unavailable, unavailable; counted/);
  assert.match(cli.stdout, /estimate note: Best-effort estimate; may be unreliable/i);

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
  assert.match(moduleSource, /quotaTokens/);
  assert.match(viewSource, /remainingEquivalentQuotaUsd/);
  assert.match(moduleSource, /account\?\.counted\?\.usedTokens/);
  assert.match(viewSource, /quotaCountedTokens\(account\)/);
  assert.match(viewSource, /account\.estimated\.remainingTokens/);
  assert.match(viewSource, /remainingTokensReliable/);
  assert.match(viewSource, /tokenTargetAccountCount/);
  assert.match(viewSource, /tokenVelocityAccountCount/);
  assert.match(viewSource, /dollarTargetAccountCount/);
  assert.match(viewSource, /dollarVelocityAccountCount/);
  assert.match(viewSource, /actualVelocityUsdPerSecond/);
  const help = execFileSync(process.execPath, ['bin/cli.js', '--help'], { encoding: 'utf8' });
  assert.match(help, /quota --refresh/);
  assert.match(help, /quota --json/);
});

test('quota UI does not render unavailable numeric values as zero', () => {
  const page = createUsagePricingPageModule();
  assert.equal(page.quotaMoney(null), 'Unavailable');
  assert.equal(page.quotaTokens(null), 'Unavailable');
  assert.equal(page.quotaTokenRate(null), 'Unavailable');
  assert.equal(page.quotaProviderUsage({ state: 'ok', measured: { usedPercent: null } }), 'Unavailable');
  assert.equal(page.quotaProviderUsage({ state: 'error', measured: { usedPercent: null } }), 'Unavailable · error');
  assert.equal(page.quotaProviderUsage({ state: 'blocked', measured: { usedPercent: 0 } }), '0.0% · blocked');
  assert.equal(page.quotaCountedTokens({ counted: { usedTokens: 100, complete: false } }), '≥100 · partial');
  assert.equal(page.quotaAggregateCountedTokens({ countedTokensUsed: 100, countedTokensComplete: false }), '≥100 · partial');
});

test('both native Codex response routes plumb measured usage into receipts', () => {
  for (const relativePath of ['../../src/routes/responses-route.js', '../../src/routes/codex-route.js']) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /createCodexUsageCollector\(\)/);
    assert.match(source, /extractCodexUsage\(JSON\.parse\(responseBody\)\)/);
    assert.match(source, /recordRequest\(\{[^}]*cacheReadTokens[^}]*cost/s);
  }
});
