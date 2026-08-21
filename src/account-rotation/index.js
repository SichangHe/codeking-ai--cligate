import {
    markRateLimited,
    markInvalid,
    clearInvalid,
    isAllRateLimited,
    getMinWaitTimeMs,
    clearExpiredLimits
} from './rate-limits.js';

import { createStrategy, getStrategyLabel, STRATEGIES } from './strategies/index.js';

export class AccountRotator {
    constructor(accountManager, strategyName = 'sequential') {
        this.accountManager = accountManager;
        this.strategy = createStrategy(strategyName);
    }

    selectAccount(modelId, options = {}) {
        const { accounts } = this._loadAccountData();
        return this.strategy.selectAccount(accounts, modelId, options);
    }

    markRateLimited(email, resetMs, modelId) {
        const { accounts } = this._loadAccountData();
        markRateLimited(accounts, email, resetMs, modelId);
        this.accountManager.save();
    }

    markInvalid(email, reason) {
        const { accounts } = this._loadAccountData();
        markInvalid(accounts, email, reason);
        this.accountManager.save();
    }

    clearInvalid(email) {
        const { accounts } = this._loadAccountData();
        clearInvalid(accounts, email);
        this.accountManager.save();
    }

    isAllRateLimited(modelId) {
        const { accounts } = this._loadAccountData();
        return isAllRateLimited(accounts, modelId);
    }

    getMinWaitTimeMs(modelId) {
        const { accounts } = this._loadAccountData();
        return getMinWaitTimeMs(accounts, modelId);
    }

    notifySuccess(account, modelId) {
        if (this.strategy.notifySuccess) {
            this.strategy.notifySuccess(account, modelId);
        }
    }

    notifyRateLimit(account, modelId) {
        if (this.strategy.notifyRateLimit) {
            this.strategy.notifyRateLimit(account, modelId);
        }
    }

    notifyFailure(account, modelId) {
        if (this.strategy.notifyFailure) {
            this.strategy.notifyFailure(account, modelId);
        }
    }

    clearExpiredLimits() {
        const { accounts } = this._loadAccountData();
        clearExpiredLimits(accounts);
        this.accountManager.save();
    }

    _loadAccountData() {
        if (typeof this.accountManager.reloadAccounts === 'function') {
            return this.accountManager.reloadAccounts();
        }
        if (typeof this.accountManager.loadAccounts === 'function') {
            return this.accountManager.loadAccounts();
        }
        return this.accountManager.listAccounts();
    }

    getStrategyName() {
        return this.strategy.name;
    }

    getStrategyLabel() {
        return getStrategyLabel(this.strategy.name);
    }
}

export {
    createStrategy,
    STRATEGIES,
    markRateLimited,
    markInvalid,
    clearInvalid,
    isAllRateLimited,
    getMinWaitTimeMs,
    clearExpiredLimits
};
