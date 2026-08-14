/**
 * Usage Tracker
 * Tracks per-request usage data for cost monitoring and analytics.
 *
 * Storage (all under ~/.cligate/):
 *   - usage-stats.json:   Aggregated stats (daily, monthly, allTime, byProvider, byModel)
 *   - usage-history.json: Recent request history (persisted, max 2000 entries)
 *
 * Writes are debounced (2s) to avoid high-frequency I/O under load.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './account-manager.js';

const STATS_FILE = join(CONFIG_DIR, 'usage-stats.json');
const HISTORY_FILE = join(CONFIG_DIR, 'usage-history.json');
const QUOTA_USAGE_FILE = join(CONFIG_DIR, 'quota-usage.json');
const MAX_HISTORY = 2000;
const DEBOUNCE_MS = 2000;
const QUOTA_BUCKET_MS = 60 * 1000;
const QUOTA_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

let aggregatedStats = null;
let usageHistory = null;
let quotaUsage = null;
let savePending = false;
let saveTimer = null;
let lastQuotaPruneMs = 0;

// ─── Load / Save ──────────────────────────────────────────────────────────────

function createEmptyStats() {
    return { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, errors: 0 };
}

function loadStats() {
    if (aggregatedStats !== null) return aggregatedStats;

    if (!existsSync(STATS_FILE)) {
        aggregatedStats = {
            daily: {},
            monthly: {},
            allTime: createEmptyStats(),
            byProvider: {},
            byModel: {},
            byAccount: {}
        };
        return aggregatedStats;
    }

    try {
        aggregatedStats = JSON.parse(readFileSync(STATS_FILE, 'utf8'));
        if (!aggregatedStats.daily) aggregatedStats.daily = {};
        if (!aggregatedStats.monthly) aggregatedStats.monthly = {};
        if (!aggregatedStats.allTime) aggregatedStats.allTime = createEmptyStats();
        if (!aggregatedStats.byProvider) aggregatedStats.byProvider = {};
        if (!aggregatedStats.byModel) aggregatedStats.byModel = {};
        if (!aggregatedStats.byAccount) aggregatedStats.byAccount = {};
    } catch {
        aggregatedStats = {
            daily: {},
            monthly: {},
            allTime: createEmptyStats(),
            byProvider: {},
            byModel: {},
            byAccount: {}
        };
    }
    return aggregatedStats;
}

function loadHistory() {
    if (usageHistory !== null) return usageHistory;

    if (!existsSync(HISTORY_FILE)) {
        usageHistory = [];
        return usageHistory;
    }

    try {
        const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
        usageHistory = Array.isArray(data) ? data : [];
    } catch {
        usageHistory = [];
    }
    return usageHistory;
}

function addQuotaUsage(target, entry) {
    if (entry.provider !== 'chatgpt-pool' || entry.success === false || !entry.keyId) return;
    const timestampMs = Date.parse(entry.timestamp || '');
    const tokens = (Number(entry.inputTokens) || 0) + (Number(entry.outputTokens) || 0);
    if (!Number.isFinite(timestampMs) || tokens <= 0) return;
    const accountKey = `${entry.provider}:${entry.keyId}`;
    const window = target.windows?.[accountKey];
    const resetAtMs = Date.parse(window?.resetAt || '');
    const windowMs = Number(window?.windowSeconds) * 1000;
    let windowStartMs = null;
    if (Number.isFinite(resetAtMs) && Number.isFinite(windowMs) && windowMs > 0) {
        windowStartMs = timestampMs < resetAtMs
            ? resetAtMs - Math.ceil((resetAtMs - timestampMs) / windowMs) * windowMs
            : resetAtMs + Math.floor((timestampMs - resetAtMs) / windowMs) * windowMs;
    }
    const minuteStartMs = Math.floor(timestampMs / QUOTA_BUCKET_MS) * QUOTA_BUCKET_MS;
    const bucketStartMs = windowStartMs === null ? minuteStartMs : Math.max(minuteStartMs, windowStartMs);
    const bucketKey = `${bucketStartMs}:${entry.model || ''}`;
    if (!target.buckets[accountKey]) target.buckets[accountKey] = {};
    const bucket = target.buckets[accountKey][bucketKey] || {
        provider: entry.provider, keyId: entry.keyId, model: entry.model || '',
        from: entry.timestamp, through: entry.timestamp, requests: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0
    };
    bucket.from = bucket.from < entry.timestamp ? bucket.from : entry.timestamp;
    bucket.through = bucket.through > entry.timestamp ? bucket.through : entry.timestamp;
    bucket.requests += 1;
    bucket.inputTokens += Number(entry.inputTokens) || 0;
    bucket.outputTokens += Number(entry.outputTokens) || 0;
    bucket.cacheReadTokens += Number(entry.cacheReadTokens) || 0;
    bucket.cost += Number(entry.cost) || 0;
    target.buckets[accountKey][bucketKey] = bucket;
}

function createQuotaUsage() {
    const history = loadHistory();
    const now = new Date().toISOString();
    const oldest = history.map(entry => entry?.timestamp).filter(Boolean).sort()[0];
    const target = {
        schemaVersion: 1,
        completeFrom: history.length < MAX_HISTORY && oldest ? oldest : now,
        migratedRecentHistory: history.length > 0,
        windows: {},
        buckets: {}
    };
    for (const entry of [...history].reverse()) addQuotaUsage(target, entry);
    return target;
}

function loadQuotaUsage() {
    if (quotaUsage !== null) return quotaUsage;
    if (existsSync(QUOTA_USAGE_FILE)) {
        try {
            const stored = JSON.parse(readFileSync(QUOTA_USAGE_FILE, 'utf8'));
            if (stored?.schemaVersion === 1 && stored.buckets && typeof stored.buckets === 'object') {
                if (!stored.windows || typeof stored.windows !== 'object') stored.windows = {};
                quotaUsage = stored;
                return quotaUsage;
            }
        } catch { /* rebuild from bounded history */ }
    }
    quotaUsage = createQuotaUsage();
    return quotaUsage;
}

function pruneQuotaUsage(target, nowMs = Date.now()) {
    if (nowMs - lastQuotaPruneMs < 60 * 60 * 1000) return;
    const cutoffMs = nowMs - QUOTA_RETENTION_MS;
    for (const [accountKey, buckets] of Object.entries(target.buckets)) {
        for (const [bucketKey, bucket] of Object.entries(buckets)) {
            if (Date.parse(bucket.through || '') < cutoffMs) delete buckets[bucketKey];
        }
        if (Object.keys(buckets).length === 0) delete target.buckets[accountKey];
    }
    lastQuotaPruneMs = nowMs;
}

function scheduleSave() {
    if (savePending) return;
    savePending = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushToDisk, DEBOUNCE_MS);
}

function flushToDisk() {
    savePending = false;
    saveTimer = null;
    try {
        if (aggregatedStats) {
            writeFileSync(STATS_FILE, JSON.stringify(aggregatedStats, null, 2), { mode: 0o600 });
        }
        if (usageHistory) {
            writeFileSync(HISTORY_FILE, JSON.stringify(usageHistory), { mode: 0o600 });
        }
        if (quotaUsage) {
            writeFileSync(QUOTA_USAGE_FILE, JSON.stringify(quotaUsage), { mode: 0o600 });
        }
    } catch { /* ignore write errors */ }
}

// Flush on process exit
process.on('exit', flushToDisk);
process.on('SIGINT', () => { flushToDisk(); process.exit(0); });
process.on('SIGTERM', () => { flushToDisk(); process.exit(0); });

function getDateKey() {
    return new Date().toISOString().slice(0, 10);
}

function getMonthKey() {
    return new Date().toISOString().slice(0, 7);
}

function addToTarget(target, entry) {
    target.requests++;
    target.inputTokens += entry.inputTokens;
    target.outputTokens += entry.outputTokens;
    target.cost += entry.cost;
    if (!entry.success) target.errors++;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function recordRequest({
    provider,
    keyId,
    model,
    inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cost = 0,
    durationMs = 0,
    success = true,
    error = null,
    timestamp = new Date().toISOString()
}) {
    const entry = {
        timestamp,
        provider,
        keyId,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cost,
        durationMs,
        success,
        error
    };
    const quotaTarget = loadQuotaUsage();

    // History (persisted)
    const history = loadHistory();
    history.unshift(entry);
    if (history.length > MAX_HISTORY) {
        usageHistory = history.slice(0, MAX_HISTORY);
    }
    addQuotaUsage(quotaTarget, entry);
    pruneQuotaUsage(quotaTarget);

    // Aggregated stats
    const stats = loadStats();
    const dayKey = getDateKey();
    const monthKey = getMonthKey();
    const providerKey = provider || 'unknown';
    const modelKey = model || 'unknown';
    const accountKey = keyId || 'unknown';

    if (!stats.daily[dayKey]) stats.daily[dayKey] = createEmptyStats();
    if (!stats.monthly[monthKey]) stats.monthly[monthKey] = createEmptyStats();
    if (!stats.byProvider[providerKey]) stats.byProvider[providerKey] = createEmptyStats();
    if (!stats.byModel[modelKey]) stats.byModel[modelKey] = createEmptyStats();
    if (!stats.byAccount[accountKey]) stats.byAccount[accountKey] = createEmptyStats();

    addToTarget(stats.daily[dayKey], entry);
    addToTarget(stats.monthly[monthKey], entry);
    addToTarget(stats.allTime, entry);
    addToTarget(stats.byProvider[providerKey], entry);
    addToTarget(stats.byModel[modelKey], entry);
    addToTarget(stats.byAccount[accountKey], entry);

    // Clean up old daily stats (keep 30 days)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    for (const key of Object.keys(stats.daily)) {
        if (key < cutoffKey) delete stats.daily[key];
    }

    // Clean up old monthly stats (keep 12 months)
    const monthCutoff = new Date();
    monthCutoff.setMonth(monthCutoff.getMonth() - 12);
    const monthCutoffKey = monthCutoff.toISOString().slice(0, 7);
    for (const key of Object.keys(stats.monthly)) {
        if (key < monthCutoffKey) delete stats.monthly[key];
    }

    scheduleSave();
    return entry;
}

export function getRecentHistory(limit = 50) {
    return loadHistory().slice(0, limit);
}

export function getQuotaUsageReceipts({ provider, keyId, fromMs, throughMs = Date.now() }) {
    const target = loadQuotaUsage();
    pruneQuotaUsage(target, throughMs);
    const accountKey = `${provider}:${keyId}`;
    let boundaryOverlap = false;
    const receipts = Object.values(target.buckets[accountKey] || {})
        .filter(bucket => {
            const bucketFromMs = Date.parse(bucket.from || '');
            const bucketThroughMs = Date.parse(bucket.through || '');
            if (bucket.provider !== provider || bucket.keyId !== keyId
                || !Number.isFinite(bucketFromMs) || !Number.isFinite(bucketThroughMs)) return false;
            const overlapsStart = bucketFromMs < fromMs && bucketThroughMs >= fromMs;
            const overlapsEnd = bucketFromMs <= throughMs && bucketThroughMs > throughMs;
            if (overlapsStart || overlapsEnd) boundaryOverlap = true;
            return bucketFromMs >= fromMs && bucketThroughMs <= throughMs;
        })
        .map(bucket => ({ ...bucket, timestamp: bucket.through }));
    const completeFromMs = Date.parse(target.completeFrom || '');
    const retainedFromMs = throughMs - QUOTA_RETENTION_MS;
    const complete = !boundaryOverlap && Number.isFinite(fromMs) && Number.isFinite(completeFromMs)
        && completeFromMs <= fromMs && retainedFromMs <= fromMs;
    scheduleSave();
    return {
        receipts,
        coverage: {
            complete,
            completeFrom: target.completeFrom || null,
            truncated: !complete
        }
    };
}

export function setQuotaUsageWindow({ provider, keyId, resetAt, windowSeconds }) {
    const resetAtMs = Date.parse(resetAt || '');
    const seconds = Number(windowSeconds);
    if (!provider || !keyId || !Number.isFinite(resetAtMs) || !Number.isFinite(seconds) || seconds <= 0) return false;
    const target = loadQuotaUsage();
    target.windows[`${provider}:${keyId}`] = {
        resetAt: new Date(resetAtMs).toISOString(),
        windowSeconds: seconds,
        updatedAt: new Date().toISOString()
    };
    scheduleSave();
    return true;
}

export function getDailyStats(days = 7) {
    const stats = loadStats();
    const result = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        result.push({
            date: key,
            ...(stats.daily[key] || createEmptyStats())
        });
    }

    return result.reverse();
}

export function getMonthlyStats(months = 6) {
    const stats = loadStats();
    const result = [];
    const now = new Date();

    for (let i = 0; i < months; i++) {
        const d = new Date(now);
        d.setMonth(d.getMonth() - i);
        const key = d.toISOString().slice(0, 7);
        result.push({
            month: key,
            ...(stats.monthly[key] || createEmptyStats())
        });
    }

    return result.reverse();
}

export function getAllTimeStats() {
    return loadStats().allTime;
}

export function getTodayStats() {
    const stats = loadStats();
    return stats.daily[getDateKey()] || createEmptyStats();
}

export function getStatsByProvider() {
    return loadStats().byProvider;
}

export function getStatsByModel() {
    return loadStats().byModel;
}

export function getStatsByAccount() {
    return loadStats().byAccount;
}
