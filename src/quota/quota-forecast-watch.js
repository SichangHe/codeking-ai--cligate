const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MIN_PACE = 0.70;
const DEFAULT_MAX_PACE = 0.95;
const DEFAULT_DEBOUNCE_MS = 60 * 60 * 1000;
const DEFAULT_MANAGER_GUIDE = 'docs/codex/cligate-quota-forecast-watch.md';
const LEGACY_MANAGER_GUIDE = 'docs/codex/cligate-quota-forecast-watch.draft.md';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, fallback, { min, max }) {
  const number = finite(value);
  if (number === null) return fallback;
  return Math.max(min, Math.min(max, number));
}

function parseTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

function isoOrNull(timeMs) {
  return Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null;
}

function guidanceFor(signal) {
  if (signal === 'too_fast') return 'Notify the main manager to slow down discretionary token-heavy work.';
  if (signal === 'too_slow') return 'Notify the main manager to pull useful deferred work forward.';
  if (signal === 'on_track') return 'Do not notify; current burn is inside the experimental target pace.';
  return 'Do not notify; quota forecast inputs are not comparable enough for a pace decision.';
}

function notificationType(signal) {
  if (signal !== 'too_fast' && signal !== 'too_slow') return null;
  return signal;
}

function legacyNotificationKey({ signal, signalSource, windowMs }) {
  if (signal !== 'too_fast' && signal !== 'too_slow') return null;
  return `${signal}:${signalSource || 'unknown'}:${windowMs}`;
}

function uniqueTokenContributorReset(accounts = []) {
  const contributors = accounts.filter(account =>
    finite(account.estimated?.targetBurnRateTokensPerSecond) !== null
    && finite(account.estimated?.actualVelocityTokensPerSecond) !== null
  );
  if (contributors.length === 0) return null;
  const resets = new Set();
  for (const account of contributors) {
    const resetAt = account.measured?.resetAt || null;
    if (!resetAt) return null;
    resets.add(resetAt);
  }
  return resets.size === 1 ? Array.from(resets)[0] : null;
}

export function normalizeForecastConfig(input = {}) {
  const windowMs = Number(input.windowMs) === 2 * DEFAULT_WINDOW_MS
    ? 2 * DEFAULT_WINDOW_MS
    : DEFAULT_WINDOW_MS;
  const managerGuidePath = typeof input.managerGuidePath === 'string' && input.managerGuidePath.trim()
    ? input.managerGuidePath.trim()
    : DEFAULT_MANAGER_GUIDE;
  return {
    windowMs,
    minPace: DEFAULT_MIN_PACE,
    maxPace: DEFAULT_MAX_PACE,
    debounceMs: clamp(input.debounceMs, DEFAULT_DEBOUNCE_MS, { min: DEFAULT_DEBOUNCE_MS, max: 24 * DEFAULT_DEBOUNCE_MS }),
    managerGuidePath: managerGuidePath === LEGACY_MANAGER_GUIDE ? DEFAULT_MANAGER_GUIDE : managerGuidePath
  };
}

export function buildQuotaForecast(snapshot, {
  nowMs = Date.now(),
  config = {},
  previousNotification = null
} = {}) {
  const normalized = normalizeForecastConfig(config);
  const aggregate = snapshot?.aggregate || {};
  const contributorReset = uniqueTokenContributorReset(snapshot?.accounts || []);
  const comparable = aggregate.signalSource === 'tokens'
    && contributorReset !== null
    && contributorReset === aggregate.nextResetAt;
  const resetAtMs = parseTime(aggregate.nextResetAt);
  const secondsToReset = resetAtMs === null ? null : Math.max(0, (resetAtMs - nowMs) / 1000);
  const remainingTokens = finite(aggregate.remainingTokens);
  const actualVelocityTokensPerSecond = finite(aggregate.actualVelocityTokensPerSecond);
  const targetVelocityTokensPerSecond = remainingTokens === null || secondsToReset === null || secondsToReset <= 0
    ? null
    : remainingTokens / secondsToReset;
  const paceRatio = !comparable || actualVelocityTokensPerSecond === null || targetVelocityTokensPerSecond === null || targetVelocityTokensPerSecond <= 0
    ? null
    : actualVelocityTokensPerSecond / targetVelocityTokensPerSecond;
  const projectedTokensUsedByReset = actualVelocityTokensPerSecond === null || secondsToReset === null
    ? null
    : actualVelocityTokensPerSecond * secondsToReset;
  const projectedRemainingTokensAtReset = projectedTokensUsedByReset === null || remainingTokens === null
    ? null
    : Math.max(0, Math.floor(remainingTokens - projectedTokensUsedByReset));
  const projectedExhaustionAtMs = actualVelocityTokensPerSecond === null || actualVelocityTokensPerSecond <= 0 || remainingTokens === null
    ? null
    : nowMs + (remainingTokens / actualVelocityTokensPerSecond) * 1000;
  const signal = paceRatio === null
    ? 'unavailable'
    : paceRatio > normalized.maxPace
      ? 'too_fast'
      : paceRatio < normalized.minPace
        ? 'too_slow'
        : 'on_track';
  const type = notificationType(signal);
  const key = legacyNotificationKey({ signal, signalSource: 'tokens', windowMs: normalized.windowMs });
  const last = previousNotification && typeof previousNotification === 'object' ? previousNotification : {};
  const lastAtMs = parseTime(last.notifiedAt);
  const sameType = type !== null && (last.type === type || last.signal === type);
  const debounced = sameType && lastAtMs !== null && nowMs - lastAtMs < normalized.debounceMs;
  const shouldNotify = (signal === 'too_fast' || signal === 'too_slow') && !debounced;
  return {
    schemaVersion: 1,
    experimental: true,
    generatedAt: isoOrNull(nowMs),
    state: signal === 'unavailable' ? 'unavailable' : 'ok',
    signal,
    signalSource: paceRatio === null ? 'unavailable' : 'tokens',
    windowMs: normalized.windowMs,
    targetPace: { min: normalized.minPace, max: normalized.maxPace },
    forecast: {
      resetAt: aggregate.nextResetAt || null,
      secondsToReset,
      remainingTokens: remainingTokens ?? null,
      actualVelocityTokensPerSecond,
      targetVelocityTokensPerSecond,
      paceRatio,
      projectedTokensUsedByReset,
      projectedRemainingTokensAtReset,
      projectedExhaustionAt: isoOrNull(projectedExhaustionAtMs)
    },
    notification: {
      shouldNotify,
      reason: signal === 'too_fast' || signal === 'too_slow'
        ? debounced ? 'debounced_duplicate' : 'pace_outside_target'
        : 'no_notification_for_current_signal',
      sameTypeSuppressed: Boolean(debounced),
      type,
      duplicateSuppressed: Boolean(debounced),
      key,
      nextAllowedAt: sameType && lastAtMs !== null ? isoOrNull(lastAtMs + normalized.debounceMs) : null,
      managerGuidePath: normalized.managerGuidePath,
      message: shouldNotify
        ? `Quota forecast is ${signal.replace('_', ' ')}; read ${normalized.managerGuidePath}.`
        : null
    },
    guidance: guidanceFor(signal),
    limits: {
      measured: 'Provider reset time and percent are measured only when the provider reports them.',
      counted: 'Token velocity comes from CliGate request receipts in the selected one- or two-hour window.',
      estimated: 'Forecasts use remaining-token estimates and are unavailable when target and velocity inputs are not comparable.',
      notification: 'This component emits a main-manager notification decision; the manager-side scheduler or caller is responsible for delivering it.'
    }
  };
}
