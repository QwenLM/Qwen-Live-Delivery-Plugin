import type { CliAdapter } from '../../integration/cli-adapter.js';
import { encodeCommandHook, normalizeCommandHook } from '../../integration/command-hook.js';
import { findCliInstance, processArgs } from '../../shared/cli-process.js';

function isQwenCli(name: string, pid: number) {
  if (/^qwen(?:-code)?$/.test(name)) return true;
  return (
    name === 'node' &&
    /^(?:.*\/)?node\s+(?:[^\s]*\/)?(?:qwen|qwen-code\/(?:[^\s]*\/)?(?:cli-entry|cli)\.js)(?:\s|$)/.test(
      processArgs(pid),
    )
  );
}

export const qwenCli: CliAdapter = {
  id: 'qwen-code',
  defaultPort: 0,
  loopbackOnly: true,
  instance: () => {
    const instance = findCliInstance(isQwenCli);
    if (!instance)
      throw new Error(
        'No Qwen Code CLI process found. Start Live Delivery from a standalone qwen CLI.',
      );
    return instance;
  },
  model: () => process.env.OPENAI_MODEL || process.env.QWEN_MODEL || 'unknown',
  normalizeHook: normalizeCommandHook,
  encodeHook: encodeCommandHook,
  feedbackOnPrompt: true,
};
