import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexUsageCollector, extractCodexUsage } from '../../src/quota/codex-usage-collector.js';

test('extracts token and cache usage from a completed Codex response', () => {
  assert.deepEqual(extractCodexUsage({ response: { usage: {
    input_tokens: 120,
    output_tokens: 30,
    input_tokens_details: { cached_tokens: 80 }
  } } }), { inputTokens: 120, outputTokens: 30, cacheReadTokens: 80 });
});

test('collects usage from SSE chunks without modifying the stream', () => {
  const collector = createCodexUsageCollector();
  const encoder = new TextEncoder();
  collector.push(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"usa'));
  collector.push(encoder.encode('ge":{"input_tokens":120,"output_tokens":30,"input_tokens_details":{"cached_tokens":80}}}}\n\n'));
  assert.deepEqual(collector.finish(), { inputTokens: 120, outputTokens: 30, cacheReadTokens: 80 });
});
