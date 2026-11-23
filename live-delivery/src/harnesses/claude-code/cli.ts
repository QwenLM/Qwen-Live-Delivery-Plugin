import type { CliAdapter } from '../../integration/cli-adapter.js';
import { encodeCommandHook, normalizeCommandHook } from '../../integration/command-hook.js';
import { findCliInstance, processArgs } from '../../shared/cli-process.js';
import { decodeClaudeUsage } from './usage.js';

/** Claude Code runs plugin skills as slash commands: `/ld:go <task>`. */
export const CLAUDE_TASK_COMMAND = /^\s*\/ld:go(?:\s+([\s\S]*)|$)/;

function isClaudeCli(name: string, pid: number) {
  if (name === 'claude') return true;
  return (
    name === 'node' &&
    /^(?:.*\/)?node\s+(?:[^\s]*\/)?(?:claude|@anthropic-ai\/claude-code\/cli\.js)(?:\s|$)/.test(
      processArgs(pid),
    )
  );
}

export const claudeCli: CliAdapter = {
  id: 'claude-code',
  defaultPort: 0,
  loopbackOnly: true,
  instance: () => {
    const instance = process.env.QWEN_LD_INSTANCE_ID || findCliInstance(isClaudeCli);
    if (!instance)
      throw new Error(
        'No Claude Code CLI process found. Start Live Delivery from a standalone claude CLI.',
      );
    return instance;
  },
  explicitSessionKey: () => process.env.QWEN_LD_SESSION_KEY || undefined,
  // SessionStart reports the active model; this only covers MCP-first startup.
  model: () => process.env.ANTHROPIC_MODEL || 'unknown',
  normalizeHook: (input, now) => normalizeCommandHook(input, now, CLAUDE_TASK_COMMAND),
  encodeHook: encodeCommandHook,
  transcriptUsage: decodeClaudeUsage,
  // Claude Code has no Interrupt event or resumable app server; queued feedback
  // reaches the agent at prompt, tool and turn-end boundaries.
  feedbackOnPrompt: true,
};
