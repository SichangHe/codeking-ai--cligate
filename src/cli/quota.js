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
  console.log(`remaining ${money(aggregate.remainingEquivalentQuotaUsd)} | target ${hourly(aggregate.targetBurnRateUsdPerSecond)} | actual ${hourly(aggregate.actualVelocityUsdPerSecond)}`);
  console.log(`next reset ${aggregate.nextResetAt || 'unavailable'} | accounts ${aggregate.usableAccountCount || 0}/${aggregate.accountCount || 0}`);
  for (const account of snapshot.accounts || []) {
    const used = account.measured?.usedPercent === null ? account.state : `${account.measured.usedPercent.toFixed(1)}% used`;
    console.log(`${account.account}: ${used}, ${money(account.estimated?.remainingEquivalentQuotaUsd)}, ${account.estimated?.signal || 'unavailable'}`);
  }
}

main().catch(error => {
  console.error(`quota unavailable: ${error.message}`);
  process.exitCode = 1;
});
