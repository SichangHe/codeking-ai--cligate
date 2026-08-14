export function createUsagePricingPageModule() {
  return {
    usageOverview: { today: {}, allTime: {}, keys: {} },
    dailyStats: [],
    dailyDays: 7,
    usageHistory: [],
    providerStats: {},
    modelStats: {},
    accountStats: {},
    accountKeyNameMap: {},
    pricingSummary: { providers: 0, models: 0, customOverrides: 0, unit: 'USD / 1M tokens' },
    pricingEntries: [],
    pricingFilter: '',
    pricingProviderFilter: '',
    pricingSaving: {},
    quotaSnapshot: null,
    quotaLoading: false,

    get dailyChartMax() {
      if (!this.dailyStats.length) return 1;
      return Math.max(1, ...this.dailyStats.map((day) => day.requests));
    },

    get providerStatsEntries() {
      const entries = Object.entries(this.providerStats)
        .map(([name, stats]) => ({ name, ...stats }))
        .sort((a, b) => b.requests - a.requests);
      const max = Math.max(1, ...entries.map((entry) => entry.requests));
      return entries.map((entry) => ({ ...entry, pct: (entry.requests / max) * 100 }));
    },

    get modelStatsEntries() {
      const entries = Object.entries(this.modelStats)
        .map(([name, stats]) => ({ name, ...stats }))
        .sort((a, b) => b.requests - a.requests);
      const max = Math.max(1, ...entries.map((entry) => entry.requests));
      return entries.map((entry) => ({ ...entry, pct: (entry.requests / max) * 100 }));
    },

    get accountStatsEntries() {
      const entries = Object.entries(this.accountStats)
        .map(([name, stats]) => ({ name, displayName: this.accountKeyNameMap[name] || name, ...stats }))
        .sort((a, b) => b.requests - a.requests);
      const max = Math.max(1, ...entries.map((entry) => entry.requests));
      return entries.map((entry) => ({ ...entry, pct: (entry.requests / max) * 100 }));
    },

    get pricingProviders() {
      return [...new Set(this.pricingEntries.map((entry) => entry.provider))].sort();
    },

    get filteredPricingEntries() {
      const query = this.pricingFilter.trim().toLowerCase();
      return this.pricingEntries.filter((entry) => {
        if (this.pricingProviderFilter && entry.provider !== this.pricingProviderFilter) return false;
        if (!query) return true;
        return entry.provider.toLowerCase().includes(query) || entry.model.toLowerCase().includes(query);
      });
    },

    async loadUsageData() {
      const [overviewRes, dailyRes, historyRes, providerRes, modelRes, accountRes, keysRes, quotaRes] = await Promise.all([
        this.api('/api/usage/overview'),
        this.api(`/api/usage/daily?days=${this.dailyDays}`),
        this.api('/api/usage/history?limit=50'),
        this.api('/api/usage/providers'),
        this.api('/api/usage/models'),
        this.api('/api/usage/accounts'),
        this.api('/api/keys'),
        this.api('/api/quota')
      ]);

      if (keysRes.ok && keysRes.data?.keys) {
        const map = {};
        for (const key of keysRes.data.keys) {
          map[key.id] = `${key.id}（${key.name || key.type}）`;
        }
        this.accountKeyNameMap = map;
      }
      if (overviewRes.ok && overviewRes.data) {
        this.usageOverview = overviewRes.data;
      }
      if (dailyRes.ok && dailyRes.data?.stats) {
        this.dailyStats = dailyRes.data.stats;
      }
      if (historyRes.ok && historyRes.data?.history) {
        this.usageHistory = historyRes.data.history;
      }
      if (providerRes.ok && providerRes.data?.stats) {
        this.providerStats = providerRes.data.stats;
      }
      if (modelRes.ok && modelRes.data?.stats) {
        this.modelStats = modelRes.data.stats;
      }
      if (accountRes.ok && accountRes.data?.stats) {
        this.accountStats = accountRes.data.stats;
      }
      if (quotaRes.ok && quotaRes.data?.schemaVersion === 1) {
        this.quotaSnapshot = quotaRes.data;
      }
    },

    async setDailyDays(days) {
      this.dailyDays = days;
      const res = await this.api(`/api/usage/daily?days=${days}`);
      if (res.ok && res.data?.stats) {
        this.dailyStats = res.data.stats;
      }
    },

    async refreshUsageData() {
      this.quotaLoading = true;
      await this.api('/api/quota/refresh', { method: 'POST' });
      await this.loadUsageData();
      this.quotaLoading = false;
      this.showToast(this.t('usageRefreshed'), 'success');
    },

    quotaMoney(value) {
      return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
        ? `$${Number(value).toFixed(2)}`
        : 'Unavailable';
    },

    quotaRate(value) {
      return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
        ? `$${(Number(value) * 3600).toFixed(2)}/h`
        : 'Unavailable';
    },

    quotaTokens(value) {
      return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
        ? Math.round(Number(value)).toLocaleString()
        : 'Unavailable';
    },

    quotaTokenRate(value) {
      return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
        ? `${Math.round(Number(value) * 3600).toLocaleString()}/h`
        : 'Unavailable';
    },

    quotaProviderUsage(account) {
      const usedPercent = account?.measured?.usedPercent;
      const measured = usedPercent !== null && usedPercent !== undefined && usedPercent !== '' && Number.isFinite(Number(usedPercent))
        ? `${Number(usedPercent).toFixed(1)}%`
        : 'Unavailable';
      if (account?.state === 'blocked') return `${measured} · blocked`;
      return account?.state && account.state !== 'ok' ? `${measured} · ${account.state}` : measured;
    },

    quotaCountedTokens(account) {
      const value = this.quotaTokens(account?.counted?.usedTokens);
      return account?.counted?.complete === false ? `≥${value} · partial` : value;
    },

    quotaAggregateCountedTokens(aggregate) {
      const value = this.quotaTokens(aggregate?.countedTokensUsed);
      return aggregate?.countedTokensComplete === false ? `≥${value} · partial` : value;
    },

    quotaSignalLabel(value) {
      return ({ speed_up: 'Speed up', slow_down: 'Slow down', on_track: 'On track', unavailable: 'Uncertain' })[value] || 'Uncertain';
    },

    quotaSignalClass(value) {
      if (value === 'speed_up') return 'text-neon-cyan';
      if (value === 'slow_down') return 'text-yellow-400';
      if (value === 'on_track') return 'text-neon-green';
      return 'text-gray-500';
    },

    async loadPricingData() {
      const res = await this.api('/api/pricing');
      if (res.ok && res.data?.success) {
        this.pricingSummary = res.data.summary || this.pricingSummary;
        this.pricingEntries = (res.data.entries || []).map((entry) => ({
          ...entry,
          form: {
            input: entry.effective?.input ?? 0,
            output: entry.effective?.output ?? 0,
            cacheRead: entry.effective?.cacheRead ?? 0,
            cacheWrite: entry.effective?.cacheWrite ?? 0
          }
        }));
      }
    },

    pricingKey(entry) {
      return `${entry.provider}:${entry.model}`;
    },

    async savePricingEntry(entry) {
      const key = this.pricingKey(entry);
      this.pricingSaving[key] = true;
      const payload = {
        provider: entry.provider,
        model: entry.model,
        input: entry.form.input,
        output: entry.form.output,
        cacheRead: entry.form.cacheRead,
        cacheWrite: entry.form.cacheWrite
      };
      const res = await this.api('/api/pricing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      this.pricingSaving[key] = false;
      if (res.ok && res.data?.success) {
        await this.loadPricingData();
        this.showToast(this.t('pricingSaved'), 'success');
      } else {
        this.showToast(res.data?.error || this.t('pricingSaveFailed'), 'error');
      }
    },

    async resetPricingEntry(entry) {
      const key = this.pricingKey(entry);
      this.pricingSaving[key] = true;
      const res = await this.api('/api/pricing/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: entry.provider, model: entry.model })
      });
      this.pricingSaving[key] = false;
      if (res.ok && res.data?.success) {
        await this.loadPricingData();
        this.showToast(this.t('pricingReset'), 'success');
      } else {
        this.showToast(res.data?.error || this.t('pricingResetFailed'), 'error');
      }
    }
  };
}
