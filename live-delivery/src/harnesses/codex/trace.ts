import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { AgentOutput, ExecutionEvent, ExecutionTrace } from '../../delivery/events.js';
import { publicAgentText, publicFiles } from '../../shared/public-activity.js';

const cache = new Map<string, { stamp: string; trace: ExecutionTrace }>();

/** Describe commands from a small vocabulary, never copy command arguments or output. */
function commandLabel(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined;
  const known =
    /(?:^|[\s;&|])((?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint|typecheck)|git\s+(?:diff|status)|pytest|tsc)(?=[\s;&|]|$)/.exec(
      command,
    );
  if (known) return known[1].replace(/\s+/g, ' ');
  return /(?:^|[\s;&|])(python3?|node|rg|cat|sed|ls)(?=\s|$)/.exec(command)?.[1];
}
export function codexExecutionEvent(
  raw: unknown,
  workspace: string,
  now: number,
): ExecutionEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as Record<string, any>;
  const item = event.item;
  if (
    ['item.started', 'item.updated', 'item.completed'].includes(event.type) &&
    item &&
    typeof item.id === 'string'
  ) {
    const status =
      item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)
        ? 'failed'
        : event.type === 'item.completed'
          ? 'completed'
          : 'running';
    const base = { id: item.id, ts: now, status } as const;
    if (item.type === 'command_execution')
      return {
        ...base,
        kind: 'command',
        tool: 'shell',
        detail: commandLabel(item.command),
        ...(status === 'failed' &&
        typeof item.aggregated_output === 'string' &&
        /bwrap: Creating new namespace failed/.test(item.aggregated_output)
          ? { failure: 'sandbox-unavailable' as const }
          : {}),
      };
    if (item.type === 'file_change')
      return {
        ...base,
        kind: 'files',
        tool: 'apply_patch',
        files: publicFiles(
          (item.changes ?? []).map((c: any) => c.path),
          workspace,
        ),
      };
    if (item.type === 'web_search') return { ...base, kind: 'search', tool: 'web_search' };
    if (
      item.type === 'mcp_tool_call' &&
      typeof item.tool === 'string' &&
      /^[\w.:/-]{1,120}$/.test(item.tool)
    )
      return { ...base, kind: 'tool', tool: item.tool };
    return null;
  }
  return null;
}

/** One bounded read for public messages and tools. Partial JSON and reasoning are ignored. */
export function readExecutionTrace(
  file: string,
  workspace: string,
  now = Date.now(),
): ExecutionTrace {
  let fd: number | undefined;
  try {
    const info = statSync(file),
      stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
    const previous = cache.get(file);
    if (previous?.stamp === stamp) return previous.trace;
    const start = Math.max(0, info.size - 256 * 1024);
    const bytes = Buffer.alloc(info.size - start);
    fd = openSync(file, 'r');
    const count = readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.subarray(0, count).toString('utf8').split('\n');
    let order = start;
    if (start) order += Buffer.byteLength(lines.shift() ?? '') + 1;
    lines.pop(); // Never parse an unfinished final record.
    const result = new Map<string, ExecutionEvent>();
    const output = new Map<string, AgentOutput>();
    const timestamped = new Set<string>();
    const publications: Array<{ order: number; ts: number }> = [];
    let segment = 0;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const timestamp = Date.parse(parsed.timestamp);
        const ts = Number.isFinite(timestamp) ? timestamp : Math.min(now, info.mtimeMs);
        if (parsed.type === 'thread.started') {
          // `exec resume` can reuse item IDs; keep earlier entries distinct.
          segment = order;
          for (const event of result.values())
            if (event.status === 'running') event.status = 'interrupted';
          for (const message of output.values())
            if (message.status === 'streaming') message.status = 'interrupted';
        }
        const item = parsed.item;
        if (
          parsed.type === 'item.completed' &&
          item?.type === 'mcp_tool_call' &&
          item.tool === 'ld_publish'
        ) {
          const result = item.result?.structured_content ?? item.result?.structuredContent;
          if (result?.ok === true && Number.isFinite(result.published?.ts))
            publications.push({ order, ts: result.published.ts });
        }
        if (
          ['item.started', 'item.updated', 'item.completed'].includes(parsed.type) &&
          item?.type === 'agent_message' &&
          typeof item.id === 'string' &&
          typeof item.text === 'string'
        ) {
          const id = segment ? `${item.id}@${segment}` : item.id;
          if (Number.isFinite(timestamp)) timestamped.add(id);
          const prior = output.get(id) ?? previous?.trace.output.find((m) => m.id === id);
          // Redact before truncating so a cut does not reveal a prefix of a credential.
          const text = publicAgentText(item.text);
          output.set(id, {
            id,
            text,
            status: parsed.type === 'item.completed' ? 'completed' : 'streaming',
            ts: prior?.ts ?? ts,
            order: prior?.order ?? order,
          });
        }
        const entry = codexExecutionEvent(parsed, workspace, ts);
        if (!entry) continue;
        if (segment) entry.id += `@${segment}`;
        const prior = result.get(entry.id) ?? previous?.trace.events.find((e) => e.id === entry.id);
        if (prior) entry.ts = prior.ts;
        entry.order = prior?.order ?? order;
        result.set(entry.id, entry);
      } catch {
        /* A truncated or unrelated event cannot break the dashboard. */
      } finally {
        order += Buffer.byteLength(line) + 1;
      }
    }
    const events = [...result.values()].slice(-80);
    const trace = {
      events,
      output: [...output.values()].slice(-40).map((message) => ({
        ...message,
        ...(!timestamped.has(message.id)
          ? { beforeTs: publications.find((p) => p.order > message.order)?.ts }
          : {}),
      })),
    };
    cache.delete(file);
    cache.set(file, { stamp, trace });
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    return trace;
  } catch {
    return { events: [], output: [] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
