import type { UsageDecoder } from '../../integration/usage.js';

export const decodeCodexUsage: UsageDecoder = (record) => {
  const usage =
    record.type === 'event_msg' &&
    record.payload?.type === 'token_count' &&
    record.payload.info?.total_token_usage;
  if (!usage) return;
  const cacheRead = usage.cached_input_tokens ?? 0;
  const cacheCreate = usage.cache_write_input_tokens ?? 0;
  return {
    kind: 'cumulative',
    counts: {
      input: Math.max(0, (usage.input_tokens ?? 0) - cacheRead - cacheCreate),
      output: usage.output_tokens ?? 0,
      cacheRead,
      cacheCreate,
    },
  };
};
