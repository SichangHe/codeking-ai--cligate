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
  console.log(`tokens counted ${aggregateCounted} | estimated left ${tokens(aggregate.remainingTokens)} | estimates ${aggregate.tokenEstimateAccountCount || 0}/${aggregate.accountCount || 0} accounts`);
  console.log(`token target ${tokensHourly(aggregate.targetBurnRateTokensPerSecond)} | actual ${tokensHourly(aggregate.actualVelocityTokensPerSecond)}`);
  console.log(`remaining ${money(aggregate.remainingEquivalentQuotaUsd)} | target ${hourly(aggregate.targetBurnRateUsdPerSecond)} | actual ${hourly(aggregate.actualVelocityUsdPerSecond)}`);
  console.log(`next reset ${aggregate.nextResetAt || 'unavailable'} | accounts ${aggregate.usableAccountCount || 0}/${aggregate.accountCount || 0}`);
  for (const account of snapshot.accounts || []) {
    const usedPercent = account.measured?.usedPercent;
    const measured = usedPercent !== null && usedPercent !== undefined && Number.isFinite(Number(usedPercent))
      ? `${Number(usedPercent).toFixed(1)}% measured used`
      : account.state;
    const provider = account.state === 'blocked' ? `${measured}, provider blocked` : measured;
    const counted = account.counted?.complete === false
      ? `at least ${tokens(account.counted?.usedTokens)} used (partial)`
      : `${tokens(account.counted?.usedTokens)} used`;
    console.log(`${account.account}: ${provider}; counted ${counted}; estimated ${tokens(account.estimated?.remainingTokens)} left; ${account.estimated?.signal || 'unavailable'}`);
  }
}

main().catch(error => {
  console.error(`quota unavailable: ${error.message}`);
  process.exitCode = 1;
});
