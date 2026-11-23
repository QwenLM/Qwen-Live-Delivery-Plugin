import type { ExecutionEvent } from '../delivery/events.js';
import { publicFiles } from '../shared/public-activity.js';

export function hookExecutionEvent(
  event: Record<string, unknown>,
  workspace: string,
  now: number,
): ExecutionEvent | null {
  // CLI hooks cover clients without a JSON trajectory stream. Only tool metadata is used.
  if (event.hook_event_name === 'PostToolUse' && typeof event.tool_name === 'string') {
    const tool = event.tool_name;
    if (!/^[\w.:/-]{1,120}$/.test(tool)) return null;
    const input =
      event.tool_input && typeof event.tool_input === 'object'
        ? (event.tool_input as Record<string, unknown>)
        : {};
    return {
      id: typeof event.tool_use_id === 'string' ? event.tool_use_id : `${tool}-${now}`,
      tool,
      kind: 'tool',
      status: 'completed',
      ts: now,
      files: publicFiles([input.file_path, input.path], workspace),
    };
  }
  return null;
}
