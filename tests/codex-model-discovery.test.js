import './test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { collectCodexModelsForAccounts, mapWithConcurrency } = await import('../src/routes/codex-route.js');

function response(status, body) {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

test('Codex model discovery returns the union from usable accounts despite a transient reduced list', async () => {
  const seenAccountIds = [];
  const result = await collectCodexModelsForAccounts(
    [{ email: 'first@example.test' }, { email: 'second@example.test' }],
    '0.147.0',
    {
      getCredentials: async (email) => ({ accessToken: `token-${email}`, accountId: email, email }),
      request: async (_url, options) => {
        const accountId = options.headers['ChatGPT-Account-ID'];
        seenAccountIds.push(accountId);
        return accountId === 'first@example.test'
          ? response(200, JSON.stringify({ models: [{ slug: 'gpt-5.5' }, { slug: 'gpt-5.4-mini' }], catalog_version: 'first' }))
          : response(200, JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.5' }] }));
      }
    }
  );

  assert.deepEqual(seenAccountIds, ['first@example.test', 'second@example.test']);
  assert.equal(result.successfulAccounts, 2);
  assert.equal(result.failures.length, 0);
  assert.equal(result.envelope.catalog_version, 'first');
  assert.deepEqual(result.models.map((model) => model.slug), ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.6-sol']);
});

test('Codex model discovery keeps successful-account models when another account errors', async () => {
  const result = await collectCodexModelsForAccounts(
    [{ email: 'working@example.test' }, { email: 'broken@example.test' }],
    '0.147.0',
    {
      getCredentials: async (email) => ({ accessToken: 'token', accountId: email, email }),
      request: async (_url, options) => options.headers['ChatGPT-Account-ID'] === 'working@example.test'
        ? response(200, JSON.stringify({ models: [{ slug: 'gpt-5.5' }] }))
        : response(503, JSON.stringify({ error: { message: 'temporary upstream failure' } }))
    }
  );

  assert.equal(result.successfulAccounts, 1);
  assert.deepEqual(result.models.map((model) => model.slug), ['gpt-5.5']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].status, 503);
});

test('Codex model discovery bounds concurrent upstream probes', async () => {
  let running = 0;
  let maximumRunning = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    running++;
    maximumRunning = Math.max(maximumRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(maximumRunning, 2);
});
