import type { CliAdapter } from '../../integration/cli-adapter.js';
import { encodeCommandHook, normalizeCommandHook } from '../../integration/command-hook.js';
import { findCliInstance } from '../../shared/cli-process.js';
import { configuredCodexModel } from './model.js';
import { decodeCodexUsage } from './usage.js';

export const codexCli: CliAdapter = {
  id: 'codex',
  defaultPort: 18791,
  instance: () =>
    process.env.QWEN_LD_INSTANCE_ID ||
    findCliInstance((name) => /^codex(?:$|[-.])/.test(name)) ||
    `parent-${process.ppid}`,
  explicitSessionKey: () => process.env.QWEN_LD_SESSION_KEY || undefined,
  model: configuredCodexModel,
  normalizeHook: normalizeCommandHook,
  encodeHook: encodeCommandHook,
  transcriptUsage: decodeCodexUsage,
  feedbackHandoff: () => process.env.QWEN_LD_FEEDBACK_HANDOFF,
};
