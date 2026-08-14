import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchUsage } from '../../src/model-api.js';
import { normalizeCodexStatus } from '../../src/quota/quota-service.js';

test('missing provider primary-window usage remains unavailable', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    plan_type: 'pro',
    rate_limit: { allowed: true, limit_reached: false }
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const usage = await fetchUsage('test-token', 'test-account');
  assert.equal(usage.totalTokenUsage, null);
  assert.equal(usage.percentage, null);
  assert.equal(usage.remaining, null);

  const status = normalizeCodexStatus('user@example.com', {
    usage,
    fetchedAt: new Date().toISOString()
  });
  assert.equal(status.state, 'error');
  assert.equal(status.source, 'provider_api_unavailable');
  assert.equal(status.usedPercent, null);
});
