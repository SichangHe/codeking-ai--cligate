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
    - continues with a lower-bound count when receipt coverage is incomplete and marks the result unreliable
  - uses the lower of provider-percentage and counted-token remainder when a token budget is configured
  - always returns a numeric per-account token estimate
    - uses a documented conservative zero fallback for blocked, errored, reset-due, or mathematically indeterminate accounts
  - smooths actual velocity over `smoothingWindowMs`
  - compares actual and target burn within `safetyMargin`
  - fails closed for money and burn guidance when status is stale, missing, errored, or provider-blocked
- consumers
  - `GET /api/quota`
  - `GET /api/quota/summary[?refresh=true]`
  - `GET /api/quota/help`
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
  - provider percentages outside `0..100` are treated as an error state and force an unreliable conservative token fallback
- `counted` contains tokens and requests observed by this CliGate instance in the reset window
  - `complete: false` means the number is a lower bound and an estimate derived from it is unreliable
- `estimated` contains derived money, tokens, rates, and guidance
- `estimated.remainingTokens` is always numeric; indeterminate cases use a conservative zero fallback
- `estimated.remainingTokensReliable`, `remainingTokensMethod`, `remainingTokensNote`, and `remainingTokensReasons` disclose the estimate quality and derivation
- `remainingTokensReliable: true` means the configured planning math has fresh usable provider data, a future reset, and complete receipts; it never guarantees actual allowance
- inferred token budgets are unreliable because provider utilization may be weighted and receipts may omit traffic that bypassed this CliGate instance
- [official Codex pricing guidance](https://developers.openai.com/codex/pricing) says usage varies with model, task size and complexity, context, reasoning, tools, retrieval, and caching, so token estimates are best-effort only
- `uncertainty` is a list of machine-readable reasons
- aggregate is `degraded` if any account is not usable
- unavailable accounts never contribute remaining equivalent quota
- aggregate remaining tokens are numeric and carry their own reliability, note, and reasons
- aggregate target token burn remains unavailable unless at least one account has an actual target rate
- aggregate `tokenTargetAccountCount` and `tokenVelocityAccountCount` identify the account subsets contributing target and actual token rates
- aggregate token guidance remains unavailable unless target and actual velocity use the same account subset
- aggregate `dollarTargetAccountCount` and `dollarVelocityAccountCount` likewise label USD rate subsets; generic guidance is unavailable when either USD or token contributor sets differ
- `aggregate.tokenEstimateAccountCount` retains its original usable-estimate meaning; `numericTokenEstimateAccountCount` counts all numeric outputs and `fallbackTokenEstimateAccountCount` counts conservative fallbacks

## local access

- web: open `http://127.0.0.1:18181`, select `Usage & Costs`, then refresh
- concise API: `curl -sS 'http://127.0.0.1:18181/api/quota/summary?refresh=true'`
- API help: `curl -sS 'http://127.0.0.1:18181/api/quota/help'`
- full web schema: `curl -sS 'http://127.0.0.1:18181/api/quota?refresh=true'`
- CLI from this checkout: `CLIGATE_URL=http://127.0.0.1:18181 node bin/cli.js quota --refresh`

## manager decision

- start with the API help response, then run its summary command
- read `aggregate.signal` only when `signalSource` is not `unavailable`
  - `slow_down`: prioritize important tasks and pause or defer discretionary token-heavy work
  - `on_track`: keep the current workload
  - `speed_up`: run useful deferred work or increase safe parallel work before quota resets unused
  - `unavailable`: inspect reliability, reasons, receipt completeness, and contributor counts; favor important work until target and actual rates are comparable
- target rate spreads estimated remaining capacity, after the safety margin, over time until `nextResetAt`
- actual rate is counted receipt velocity over the smoothing window
- refresh after a material task or account-state change
- numeric remaining-token estimates are still best-effort; use reliability metadata to decide how much safety margin to keep

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
