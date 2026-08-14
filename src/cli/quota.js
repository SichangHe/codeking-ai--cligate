#!/usr/bin/env node

const args = process.argv.slice(2);
const port = Number(process.env.PORT || 8081);
const baseUrl = process.env.CLIGATE_URL || `http://127.0.0.1:${port}`;
const refresh = args.includes('--refresh');
const json = args.includes('--json');

function money(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? `$${Number(value).toFixed(2)}`
    : 'unavailable';
}

function hourly(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? `$${(Number(value) * 3600).toFixed(2)}/h`
    : 'unavailable';
}

function tokens(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? Math.round(Number(value)).toLocaleString('en-US')
    : 'unavailable';
}

function tokensHourly(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? `${Math.round(Number(value) * 3600).toLocaleString('en-US')}/h`
    : 'unavailable';
}

function contributors(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return 'unknown accounts';
  return `${count} account${count === 1 ? '' : 's'}`;
}

async function main() {
  const response = await fetch(`${baseUrl}/api/quota${refresh ? '?refresh=true' : ''}`);
  if (!response.ok) throw new Error(`quota endpoint returned HTTP ${response.status}`);
  const snapshot = await response.json();
  if (json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  const aggregate = snapshot.aggregate || {};
  console.log(`quota: ${snapshot.state} | ${aggregate.signal || 'unavailable'}`);
  const aggregateCounted = aggregate.countedTokensComplete === false
    ? `at least ${tokens(aggregate.countedTokensUsed)} (partial)`
    : tokens(aggregate.countedTokensUsed);
  const aggregateReliability = aggregate.remainingTokensReliable === true ? 'input-complete' : 'unreliable';
  const numericEstimateAccountCount = aggregate.numericTokenEstimateAccountCount
    ?? aggregate.tokenEstimateAccountCount
    ?? 0;
  console.log(`tokens counted ${aggregateCounted} | estimated left ${tokens(aggregate.remainingTokens)} (${aggregateReliability}) | numeric estimates ${numericEstimateAccountCount}/${aggregate.accountCount || 0} accounts`);
  console.log(`estimate note: ${aggregate.remainingTokensNote || 'Best-effort estimate; may be unreliable and is not guaranteed.'}`);
  console.log(`token target ${tokensHourly(aggregate.targetBurnRateTokensPerSecond)} (${contributors(aggregate.tokenTargetAccountCount)}) | actual ${tokensHourly(aggregate.actualVelocityTokensPerSecond)} (${contributors(aggregate.tokenVelocityAccountCount)})`);
  console.log(`remaining ${money(aggregate.remainingEquivalentQuotaUsd)} | target ${hourly(aggregate.targetBurnRateUsdPerSecond)} (${contributors(aggregate.dollarTargetAccountCount)}) | actual ${hourly(aggregate.actualVelocityUsdPerSecond)} (${contributors(aggregate.dollarVelocityAccountCount)})`);
  console.log(`next reset ${aggregate.nextResetAt || 'unavailable'} | accounts ${aggregate.usableAccountCount || 0}/${aggregate.accountCount || 0}`);
  for (const account of snapshot.accounts || []) {
    const usedPercent = account.measured?.usedPercent;
    const measured = usedPercent !== null && usedPercent !== undefined && Number.isFinite(Number(usedPercent))
      ? `${Number(usedPercent).toFixed(1)}% measured used`
      : 'provider usage unavailable';
    const provider = account.state === 'blocked'
      ? `${measured}, provider blocked`
      : account.state !== 'ok' ? `${measured}, ${account.state}` : measured;
    const counted = account.counted?.complete === false
      ? `at least ${tokens(account.counted?.usedTokens)} used (partial)`
      : `${tokens(account.counted?.usedTokens)} used`;
    const estimateReliability = account.estimated?.remainingTokensReliable === true ? 'input-complete' : 'unreliable';
    console.log(`${account.account}: ${provider}; counted ${counted}; estimated ${tokens(account.estimated?.remainingTokens)} left (${estimateReliability}); ${account.estimated?.signal || 'unavailable'}`);
    if (account.estimated?.remainingTokensReliable !== true) {
      console.log(`  estimate note: ${account.estimated?.remainingTokensNote || 'Best-effort estimate; may be unreliable and is not guaranteed.'}`);
    }
  }
}

main().catch(error => {
  console.error(`quota unavailable: ${error.message}`);
  process.exitCode = 1;
});
