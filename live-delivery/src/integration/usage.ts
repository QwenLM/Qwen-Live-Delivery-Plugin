/** Best-effort transcript token estimates at hook boundaries, never billing data. */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../shared/json.js';
import type { DeliveryScope } from '../delivery/context.js';
import { getActiveId, readState, sessionDir } from '../delivery/state.js';

type Counts = { input: number; output: number; cacheRead: number; cacheCreate: number };
export type UsageDecoder = (
  record: any,
) =>
  | { kind: 'cumulative'; counts: Counts }
  | { kind: 'message'; id: string; counts: Counts }
  | undefined;
export type CdUsage = Counts & {
  scanOffset: number;
  path: string;
  ts: number;
  seen: Record<string, Counts>;
  previous?: Counts;
};
const zero = (): Counts => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
const keys = ['input', 'output', 'cacheRead', 'cacheCreate'] as const;
function usageFile(workspaceDir: string, id: string): string {
  return path.join(sessionDir(workspaceDir, id), 'usage.json');
}
export function readUsage(workspaceDir: string, id: string): CdUsage | null {
  try {
    return JSON.parse(readFileSync(usageFile(workspaceDir, id), 'utf8')) as CdUsage;
  } catch {
    return null;
  }
}

// Claude may repeat a message's usage across content blocks; keep the greatest
// observed counts for each message ID. Codex emits cumulative token_count
// records, sometimes repeatedly; add only their deltas. Exclude pre-task turns.
export function updateUsageFromTranscript(
  cfg: DeliveryScope,
  transcriptPath: string | undefined,
  decode: UsageDecoder,
): void {
  if (!transcriptPath) return;
  const id = getActiveId(cfg.workspaceDir, cfg.sessionKey);
  const state = id && readState(cfg.workspaceDir, id);
  if (!id || !state) return;
  let fd: number | undefined;
  try {
    const size = statSync(transcriptPath).size;
    let cur = readUsage(cfg.workspaceDir, id);
    if (!cur || cur.path !== transcriptPath || size < cur.scanOffset) {
      cur = { ...zero(), scanOffset: 0, path: transcriptPath, ts: 0, seen: {} };
    }
    if (size <= cur.scanOffset) return;
    fd = openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size - cur.scanOffset);
    const count = readSync(fd, buf, 0, buf.length, cur.scanOffset);
    const lastNl = buf.subarray(0, count).lastIndexOf(10);
    if (lastNl < 0) return;
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      try {
        const rec = JSON.parse(line);
        const ts = Date.parse(rec.timestamp);
        if (!Number.isFinite(ts)) continue;
        const sample = decode(rec);
        if (!sample) continue;
        const counts = sample.counts;
        if (sample.kind === 'cumulative') {
          if (ts >= state.startedTs)
            for (const key of keys)
              cur[key] += Math.max(0, counts[key] - (cur.previous?.[key] ?? 0));
          cur.previous = counts;
        } else if (ts >= state.startedTs) {
          const prior = cur.seen[sample.id] ?? zero();
          for (const key of keys) {
            counts[key] = Math.max(counts[key], prior[key]);
            cur[key] += counts[key] - prior[key];
          }
          cur.seen[sample.id] = counts;
        }
      } catch {
        /* Ignore malformed/unsupported records. */
      }
    }
    cur.scanOffset += lastNl + 1;
    cur.ts = Date.now();
    atomicJson(usageFile(cfg.workspaceDir, id), cur);
  } catch {
    /* Optional meter must never interfere with Stop or task routing. */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
