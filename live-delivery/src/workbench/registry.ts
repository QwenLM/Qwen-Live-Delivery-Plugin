import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const workspaceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    path: z.string().refine(path.isAbsolute),
  })
  .passthrough();
const runSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    sessionId: z.string(),
    sessionKey: z.string(),
    createdTs: z.number().finite().nonnegative(),
    query: z.string(),
    budgetSource: z.enum(['request', 'control']).optional(),
    parentRunId: z.string().optional(),
    status: z.enum(['starting', 'running', 'finished', 'failed', 'imported', 'attached']),
    pid: z.number().int().positive().optional(),
    pidStart: z.string().optional(),
    exitCode: z.number().int().optional(),
    error: z.string().optional(),
    feedbackWakeId: z.string().optional(),
    feedbackResumeId: z.string().optional(),
    requestId: z.string().optional(),
    requestHash: z.string().optional(),
  })
  .passthrough();
const registrySchema = z
  .object({
    workspaces: z.array(workspaceSchema),
    runs: z.array(runSchema),
  })
  .passthrough();
export type Workspace = z.infer<typeof workspaceSchema>;
export type Run = z.infer<typeof runSchema>;
export type Registry = z.infer<typeof registrySchema>;

/** Only a missing file is a new registry. Never replace unreadable or invalid history. */
export function loadRegistry(stateDir: string): Registry {
  const file = path.join(stateDir, 'registry.json');
  let text: string;
  try {
    if (!lstatSync(file).isFile()) throw new Error('Registry must be a regular file');
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { workspaces: [], runs: [] };
    throw new Error(
      `Cannot read task registry: ${file}. No records were changed. Check file permissions or restore a known-good backup.`,
    );
  }
  try {
    const registry = registrySchema.parse(JSON.parse(text));
    const workspaces = new Set(registry.workspaces.map((w) => w.id));
    const runs = new Map(registry.runs.map((r) => [r.id, r]));
    if (workspaces.size !== registry.workspaces.length || runs.size !== registry.runs.length)
      throw new Error('Duplicate identifiers');
    for (const run of registry.runs) {
      if (!workspaces.has(run.workspaceId)) throw new Error('Missing workspace');
      if (
        run.parentRunId &&
        (run.parentRunId === run.id || runs.get(run.parentRunId)?.workspaceId !== run.workspaceId)
      )
        throw new Error('Invalid parent run');
    }
    return registry;
  } catch {
    throw new Error(
      `Invalid task registry: ${file}. The original file is preserved. Restore a known-good backup, or use a new state directory to view workspace history. Do not delete the original registry.`,
    );
  }
}
