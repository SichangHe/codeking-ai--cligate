import {
  getQuotaSnapshot,
  getQuotaHistory,
  getQuotaConfig,
  updateQuotaConfig,
  refreshQuotaStatuses
} from '../quota/quota-service.js';

export async function handleGetQuotaSnapshot(req, res) {
  try {
    res.json(await getQuotaSnapshot({ refresh: req.query.refresh === 'true' }));
  } catch {
    res.status(503).json({ schemaVersion: 1, state: 'unavailable', error: 'quota_snapshot_unavailable' });
  }
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
