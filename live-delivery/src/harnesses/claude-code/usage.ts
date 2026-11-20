import type { UsageDecoder } from '../../integration/usage.js';

export const decodeClaudeUsage: UsageDecoder = (record) => {
  const usage = record.type === 'assistant' && record.message?.usage;
  const id = record.message?.id;
  if (!usage || !id) return;
  return {
    kind: 'message',
    id,
    counts: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreate: usage.cache_creation_input_tokens ?? 0,
    },
  };
};
