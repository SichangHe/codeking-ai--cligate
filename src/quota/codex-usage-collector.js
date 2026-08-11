function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function extractCodexUsage(payload) {
  const usage = payload?.response?.usage || payload?.usage;
  if (!usage || typeof usage !== 'object') return null;
  return {
    inputTokens: finite(usage.input_tokens ?? usage.prompt_tokens),
    outputTokens: finite(usage.output_tokens ?? usage.completion_tokens),
    cacheReadTokens: finite(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens)
  };
}

export function createCodexUsageCollector() {
  const decoder = new TextDecoder();
  let pending = '';
  let usage = null;

  function consumeLines(final = false) {
    const lines = pending.split(/\r?\n/);
    pending = final ? '' : (lines.pop() || '');
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        usage = extractCodexUsage(JSON.parse(data)) || usage;
      } catch {
        // incomplete or non-JSON SSE data is not a usage receipt
      }
    }
  }

  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      consumeLines();
    },
    finish() {
      pending += decoder.decode();
      pending += '\n';
      consumeLines(true);
      return usage;
    }
  };
}
