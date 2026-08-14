# quota planning

## decision

- extend CLI Gate
  - deployed package: npm `cligate@1.3.2`
  - source: `https://github.com/codeking-ai/cligate`
  - release tag commit: `04291fc3441f0b526aee703fb0a2da8f9b403949`
  - deployment: local wrapper around `createServer` on `127.0.0.1:18181`
- alternative checked: `https://github.com/router-for-me/CLIProxyAPI`
  - maintained multi-account proxy and management API/UI
  - its README says built-in usage statistics were removed in v6.10.0
  - complete history now requires another service such as CPA Usage Keeper or CPA-Manager
  - no single built-in schema provides remaining equivalent quota, target burn, actual velocity, and guidance
  - migration would replace the working proxy and split the requested feature across services

## data flow

- provider adapter
  - polls the existing Codex read-only usage and account-check interfaces
  - accepts only provider utilization, window, reset, allowed, limit, plan, and fetch time
  - discards raw provider bodies and all credential material
- receipt source
  - stores minute buckets per ChatGPT-pool account in `quota-usage.json`
  - splits buckets at registered provider reset boundaries; excludes legacy buckets that overlap a boundary and marks coverage incomplete
  - retains eight days of timestamp, account key, model, request count, input/output tokens, and effective pricing inputs
  - seeds from bounded `usage-history.json` on upgrade and marks coverage incomplete when that history had reached its cap
- observation store
  - writes normalized samples to `quota-history.json`
  - applies `retentionDays` and `maxHistoryEntries` on every write
  - writes with mode `0600`
- calculation
  - maps measured utilization to configured API-price-equivalent quota
  - counts receipt input and output tokens inside the provider reset window
  - estimates a token budget from counted tokens and a positive measured provider percentage when no token budget is configured
    - requires complete receipt coverage for the provider reset window
  - uses the lower of provider-percentage and counted-token remainder when a token budget is configured
  - smooths actual velocity over `smoothingWindowMs`
  - compares actual and target burn within `safetyMargin`
  - fails closed for stale, missing, errored, or provider-blocked status
- consumers
  - `GET /api/quota`
  - `GET /api/quota/history`
  - `GET|PUT /api/quota/config`
  - `POST /api/quota/refresh`
  - usage web view
  - `cligate quota [--refresh] [--json]`

## configuration

- `pollingIntervalMs`: provider status polling interval
- `staleAfterMs`: maximum provider observation age
- `smoothingWindowMs`: actual velocity window
- `retentionDays`: observation age limit
- `maxHistoryEntries`: observation count limit
- `safetyMargin`: fraction withheld from target burn
- `providers.codex.enabled`: Codex status adapter switch
- `providers.codex.quotaBudgetUsd`: default equivalent quota per account
  - defaults to unavailable instead of inventing a budget
  - when unset, receipts plus measured utilization can infer a high-uncertainty budget
- `providers.codex.quotaBudgetTokens`: optional raw input-plus-output token budget per account and reset window
  - defaults to unavailable instead of inventing a token limit
- `providers.codex.resetWindowSeconds`: fallback reset window
- `accountOverrides.<email>`: per-account quota and reset assumptions
- existing pricing registry: per-model input/output/cache prices

## schema rules

- schema version is `1`
- `measured` contains provider observations
- `counted` contains tokens and requests observed by this CliGate instance in the reset window
  - `complete: false` means the number is a lower bound and inferred tokens left remain unavailable
- `estimated` contains derived money, tokens, rates, and guidance
- `estimated.remainingTokens` requires fresh usable provider status, a reset time, and either a configured token budget or both counted tokens and a positive measured provider percentage
- inferred token budgets are high-uncertainty because provider utilization may be weighted and receipts may omit traffic that bypassed this CliGate instance
- `uncertainty` is a list of machine-readable reasons
- aggregate is `degraded` if any account is not usable
- unavailable accounts never contribute remaining equivalent quota

## local access

- web: open `http://127.0.0.1:18181`, select `Usage & Costs`, then refresh
- API: `curl -sS 'http://127.0.0.1:18181/api/quota?refresh=true'`
- CLI from this checkout: `CLIGATE_URL=http://127.0.0.1:18181 node bin/cli.js quota --refresh`

## rollback

- keep the current npm deployment directory and configuration unchanged
- install the reviewed checkout into a versioned canary directory
- point only `cligate-canary.service` at the versioned launcher after saving the current unit target
- verify localhost health, quota API, web assets, CLI, file permissions, and logs
- rollback by restoring the prior `ExecStart` target and restarting the user unit

## test isolation

- server-side live tests must set `HOME`, `CLIGATE_CONFIG_DIR`, `CLAUDE_CONFIG_PATH`, `CLIGATE_CLAUDE_CREDENTIALS_FILE`, and `CLIGATE_CODEX_AUTH_FILE` to one temporary root before server import
- live configuration mutation tests additionally require `LIVE_SERVER_CONFIG_ISOLATED=true`
- never point live mutation tests at a user service
