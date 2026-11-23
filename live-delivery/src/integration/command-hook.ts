import type { CliHookEvent, HookResponse } from './cli-adapter.js';
import { hookExecutionEvent } from './hook-activity.js';

/** `$ld:go <task>`: the skill invocation shared by Codex and Qwen Code. */
export const SKILL_TASK_COMMAND = /^\s*\$ld:go(?:\s+([\s\S]*)|$)/;

export function normalizeCommandHook(
  input: Record<string, unknown>,
  now: number,
  taskCommand: RegExp = SKILL_TASK_COMMAND,
): CliHookEvent | null {
  if (
    input.agent_id ||
    input.agent_type ||
    typeof input.session_id !== 'string' ||
    !input.session_id
  )
    return null;
  const name = String(input.hook_event_name ?? '');
  const phase =
    name === 'SessionStart'
      ? 'session'
      : name === 'UserPromptSubmit'
        ? 'prompt'
        : name === 'PostToolUse'
          ? 'tool-completed'
          : name === 'Stop'
            ? 'turn-end'
            : 'other';
  const workspace = typeof input.cwd === 'string' ? input.cwd : process.env.CLAUDE_PROJECT_DIR;
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const task =
    phase === 'prompt' || phase === 'session' ? taskCommand.exec(prompt)?.[1]?.trim() : undefined;
  return {
    name,
    phase,
    workspace,
    sessionId: input.session_id,
    model: typeof input.model === 'string' && input.model ? input.model : undefined,
    replacesSession: phase === 'session' && input.source === 'clear',
    task,
    transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : undefined,
    execution: hookExecutionEvent(input, workspace ?? process.cwd(), now) ?? undefined,
    userText:
      phase === 'prompt' &&
      prompt.trim() &&
      !/^\s*[/$]/.test(prompt) &&
      !/^Live Delivery:/.test(prompt)
        ? prompt
        : undefined,
    assistantText:
      phase === 'turn-end' &&
      typeof input.last_assistant_message === 'string' &&
      input.last_assistant_message.trim()
        ? input.last_assistant_message
        : undefined,
    pauseReason:
      name === 'Interrupt' ? 'interrupt' : name === 'SessionEnd' ? 'session_end' : undefined,
  };
}

export function encodeCommandHook(response: HookResponse, event: CliHookEvent) {
  const { blockReason, systemMessage, additionalContext } = response;
  if (blockReason) return { decision: 'block', reason: blockReason };
  return {
    systemMessage,
    ...(additionalContext && {
      hookSpecificOutput: {
        hookEventName: event.task ? 'UserPromptSubmit' : event.name,
        additionalContext,
      },
    }),
  };
}
