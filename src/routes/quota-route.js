import {
  getQuotaSnapshot,
  getQuotaSummary,
  getQuotaHistory,
  getQuotaConfig,
  updateQuotaConfig,
  refreshQuotaStatuses
} from '../quota/quota-service.js';
import { TOKEN_ESTIMATE_NOTE } from '../quota/quota-calculator.js';

export async function handleGetQuotaSnapshot(req, res) {
  try {
    res.json(await getQuotaSnapshot({ refresh: req.query.refresh === 'true' }));
  } catch {
    res.status(503).json({ schemaVersion: 1, state: 'unavailable', error: 'quota_snapshot_unavailable' });
  }
}

export function buildUnavailableQuotaSummary() {
  return {
    schemaVersion: 1,
    state: 'unavailable',
    error: 'quota_summary_unavailable',
    aggregate: {
      state: 'unavailable',
      accountCount: 0,
      usableAccountCount: 0,
      counted: {
        usedTokens: 0,
        complete: null,
        actualVelocityUsdPerSecond: null,
        dollarVelocityAccountCount: 0,
        actualVelocityTokensPerSecond: null,
        tokenVelocityAccountCount: 0
      },
      estimated: {
        remainingTokens: 0,
        remainingEquivalentQuotaUsd: null,
        targetBurnRateUsdPerSecond: null,
        dollarTargetAccountCount: 0,
        targetBurnRateTokensPerSecond: null,
        tokenTargetAccountCount: 0,
        reliable: false,
        accountCount: 0,
        usableAccountCount: 0,
        fallbackAccountCount: 0,
        reliableAccountCount: 0,
        note: `${TOKEN_ESTIMATE_NOTE} A conservative 0-token aggregate is used because the snapshot is unavailable.`,
        reasons: ['quota_snapshot_unavailable', 'conservative_zero_fallback']
      },
      nextResetAt: null,
      signal: 'unavailable',
      signalSource: 'unavailable'
    },
    accounts: [],
    links: { full: '/api/quota', help: '/api/quota/help' }
  };
}

export async function handleGetQuotaSummary(req, res) {
  try {
    res.json(await getQuotaSummary({ refresh: req.query.refresh === 'true' }));
  } catch {
    res.status(503).json(buildUnavailableQuotaSummary());
  }
}

export function handleGetQuotaHelp(req, res) {
  const localPort = Number(req.socket?.localPort ?? process.env.PORT ?? 8081);
  const port = Number.isInteger(localPort) && localPort > 0 && localPort <= 65_535 ? localPort : 8081;
  const origin = `http://127.0.0.1:${port}`;
  res.json({
    schemaVersion: 1,
    purpose: 'Read measured provider quota, counted proxy tokens, and best-effort token estimates without post-processing.',
    commands: {
      summary: `curl -sS '${origin}/api/quota/summary?refresh=true'`,
      help: `curl -sS '${origin}/api/quota/help'`
    },
    endpoints: [
      {
        method: 'GET',
        path: '/api/quota/summary?refresh=true',
        use: 'Refresh provider status and return the concise manager/agent view. Omit refresh=true to use cached status.'
      },
      { method: 'GET', path: '/api/quota', use: 'Return the full web-compatible quota snapshot.' },
      { method: 'GET', path: '/api/quota/help', use: 'Return these commands and field meanings.' }
    ],
    fields: {
      measured: 'Provider-reported percentage, state, and reset; not token counts.',
      counted: 'Observed tokens plus actual USD/token velocities. dollarVelocityAccountCount and tokenVelocityAccountCount identify contributors; complete=false means a lower bound.',
      estimated: 'Numeric remaining-token and remaining-quota estimates plus target USD/token rates. dollarTargetAccountCount and tokenTargetAccountCount identify contributors; token estimates include reliability metadata.',
      reliable: 'True only when fresh usable provider data, a configured token budget, a future reset, and complete receipts support the planning math; it is not a guarantee.'
    },
    planning: {
      objective: 'Use available quota for valuable work before reset without exhausting planning capacity early; preserve uncertain capacity for important work.',
      inputs: 'Read aggregate signal, signalSource, nextResetAt, target and actual rates, contributor counts, estimated reliability, counted completeness, note, and reasons from the summary.',
      target: 'Target rate spreads estimated remaining capacity, after the configured safety margin, over the time until reset. Actual rate is observed receipt velocity over the configured smoothing window.',
      rules: [
        { signal: 'slow_down', action: 'Prioritize important tasks and pause or defer discretionary token-heavy work; refresh after the important work.' },
        { signal: 'on_track', action: 'Keep the current workload and refresh after a material task or account-state change.' },
        { signal: 'speed_up', action: 'Run useful deferred work or increase safe parallel work so capacity is less likely to expire unused.' },
        { signal: 'unavailable', action: 'Do not infer pace from a numeric estimate alone; inspect reliability, reasons, completeness, and contributor counts, then favor important work until comparable rates exist.' }
      ],
      guardrail: 'Use aggregate guidance only when signalSource is not unavailable. Different target and velocity contributor sets, including different contributor counts, make rates non-comparable and suppress guidance.'
    },
    estimateNote: `${TOKEN_ESTIMATE_NOTE} Model, task complexity, context, reasoning, tools, retrieval, and caching can change actual usage.`
  });
}

export function handleGetQuotaHistory(req, res) {
  res.json({ schemaVersion: 1, history: getQuotaHistory(req.query.limit) });
}

export function handleGetQuotaConfig(req, res) {
  res.json({ schemaVersion: 1, config: getQuotaConfig() });
}

export function handleUpdateQuotaConfig(req, res) {
  try {
    res.json({ schemaVersion: 1, success: true, config: updateQuotaConfig(req.body) });
  } catch {
    res.status(400).json({ schemaVersion: 1, success: false, error: 'invalid_quota_config' });
  }
}

export async function handleRefreshQuota(req, res) {
  try {
    await refreshQuotaStatuses({ force: true });
    res.json(await getQuotaSnapshot());
  } catch {
    res.status(503).json({ schemaVersion: 1, state: 'unavailable', error: 'quota_refresh_unavailable' });
  }
}
