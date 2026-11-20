import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, realpathSync, readdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../shared/json.js';
import { DEFAULT_BASE_PATH, type CdConfig } from './config.js';
import type { HostedExecution, ResumeExecution } from './hosted-execution.js';
import { createDeliveryServer } from './http.js';
import { buildReadModel } from './read-model.js';
import { readRequestBody } from './request-body.js';
import { processStartTime as pidStart, requireSupportedPlatform } from '../shared/process.js';
import { startTask, ownedStates, continuationFrom } from '../delivery/core.js';
import { listStates, readState, writeState } from '../delivery/state.js';
import { withLock } from '../delivery/lock.js';
import { z } from 'zod';
import { WorkbenchAccess } from './access.js';
import { requestedBudget } from '../delivery/budget.js';
import { BROWSER_TASK_INSTRUCTIONS } from './instructions.js';
import { serializePriorContext } from './prior-context.js';
import { deliveryLinks } from './browser.js';
import {
  beginFeedbackHandoff,
  prepareFeedbackResume,
  cancelFeedbackHandoff,
} from './feedback-handoff.js';

import { loadRegistry, type Registry, type Run, type Workspace } from './registry.js';
export type WorkbenchOptions = {
  stateDir: string;
  workspaceRoot: string;
  maxParallel?: number;
  planMode?: 'fixed' | 'rolling';
  importWorkspaces?: string[];
};
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
function secureDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const safeName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (v) => !/[\\/\0]/.test(v) && !v.startsWith('.') && v !== '.' && v !== '..',
    'Use a workspace name, not a path.',
  );

export class WorkbenchHost {
  readonly server: Server;
  private readonly execution: HostedExecution;
  readonly access = new WorkbenchAccess(DEFAULT_BASE_PATH);
  readonly token = randomBytes(32).toString('hex');
  readonly options: Required<Omit<WorkbenchOptions, 'importWorkspaces'>>;
  private registry: Registry;
  private children = new Map<string, ChildProcess>();
  private views = new Map<string, { server: Server; cfg: CdConfig }>();
  private launching = new Set<string>();
  private waking = new Set<string>();
  private timer: ReturnType<typeof setInterval>;
  private attachedConfig?: () => CdConfig | undefined;
  private closed = false;

  constructor(input: WorkbenchOptions, createExecution: (stateDir: string) => HostedExecution) {
    requireSupportedPlatform();
    this.registry = loadRegistry(input.stateDir);
    secureDir(input.stateDir);
    mkdirSync(input.workspaceRoot, { recursive: true });
    this.options = {
      ...input,
      stateDir: realpathSync(input.stateDir),
      workspaceRoot: realpathSync(input.workspaceRoot),
      maxParallel: input.maxParallel ?? 2,
      planMode: 'rolling',
    };
    if (inside(this.options.workspaceRoot, this.options.stateDir))
      throw new Error('Keep the private runtime directory outside the selectable workspace root.');
    this.execution = createExecution(this.options.stateDir);
    for (const run of this.registry.runs) if (run.status === 'attached') run.status = 'imported';
    for (const dir of input.importWorkspaces ?? []) this.registerWorkspace(dir, true);
    for (const item of readdirSync(this.options.workspaceRoot, { withFileTypes: true }))
      if (item.isDirectory() && !item.name.startsWith('.'))
        this.registerWorkspace(path.join(this.options.workspaceRoot, item.name));
    for (const workspace of this.registry.workspaces) this.linkContinuations(workspace.id);
    this.refresh();
    this.save();
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent)
          this.json(res, 500, { ok: false, error: 'Workbench request failed.' });
        else res.end();
      });
    });
    this.server.on('listening', () => {
      for (const run of this.registry.runs) this.writeDashboardEntry(run);
    });
    this.timer = setInterval(() => this.refresh(), 1500);
    this.timer.unref();
  }
  private save() {
    if (this.closed) return;
    atomicJson(path.join(this.options.stateDir, 'registry.json'), this.registry);
  }
  private workspace(id: string) {
    const workspace = this.registry.workspaces.find((w) => w.id === id);
    if (!workspace) throw new Error('Workspace not found.');
    return workspace;
  }
  private live(run: Run) {
    if (run.status === 'attached' && this.attachedConfig) {
      const state = readState(this.workspace(run.workspaceId).path, run.sessionId);
      return !!state && ['working', 'delivered'].includes(state.status);
    }
    return (
      this.launching.has(run.id) ||
      !!(run.pid && run.pidStart && pidStart(run.pid) === run.pidStart)
    );
  }
  private busy(run: Run) {
    return (
      this.live(run) ||
      (run.status === 'imported' &&
        ['working', 'delivered'].includes(
          readState(this.workspace(run.workspaceId).path, run.sessionId)?.status ?? '',
        ))
    );
  }
  attachSession(resolve: () => CdConfig | undefined) {
    this.attachedConfig = resolve;
    this.syncAttached();
  }
  private syncAttached() {
    const cfg = this.attachedConfig?.();
    if (!cfg) return;
    const workspace = this.registry.workspaces.find(
      (w) => w.path === realpathSync(cfg.workspaceDir),
    );
    if (!workspace) return;
    let changed = false;
    const states = ownedStates(cfg);
    for (const state of states) {
      let run = this.registry.runs.find(
        (r) => r.workspaceId === workspace.id && r.sessionId === state.id,
      );
      if (!run) {
        run = {
          id: 'cli-' + hash(workspace.path + '\0' + state.id).slice(0, 20),
          workspaceId: workspace.id,
          sessionId: state.id,
          sessionKey: state.sessionKey,
          createdTs: state.startedTs,
          query: state.task,
          status: 'attached',
        };
        this.registry.runs.push(run);
        changed = true;
      } else if (run.status !== 'attached') {
        run.status = 'attached';
        changed = true;
      }
    }
    if (this.linkContinuations(workspace.id)) changed = true;
    if (changed) this.save();
  }
  private linkContinuations(workspaceId: string) {
    const records = this.registry.runs.filter((r) => r.workspaceId === workspaceId);
    const bySession = new Map(records.map((r) => [r.sessionId, r]));
    let changed = false;
    for (const record of records) {
      if (record.parentRunId) continue;
      const state = readState(this.workspace(workspaceId).path, record.sessionId);
      const parent = state?.continuation && bySession.get(state.continuation.sessionId);
      if (parent && parent.id !== record.id && parent.createdTs <= record.createdTs) {
        record.parentRunId = parent.id;
        changed = true;
      }
    }
    return changed;
  }
  private registerWorkspace(given: string, explicit = false): Workspace {
    const dir = realpathSync(given);
    if (!explicit && !inside(this.options.workspaceRoot, dir))
      throw new Error('Select a directory inside the configured workspace root.');
    for (const forbidden of [this.options.stateDir, ...this.execution.privateDirectories])
      if (inside(forbidden, dir) || inside(dir, forbidden))
        throw new Error('A private runtime, plugin or credential directory cannot be a workspace.');
    let found = this.registry.workspaces.find((w) => w.path === dir);
    if (found) return found;
    found = {
      id: 'ws-' + hash(dir).slice(0, 16),
      name:
        path.basename(dir) === 'workspace'
          ? (listStates(dir)[0]?.name ?? path.basename(path.dirname(dir)))
          : path.basename(dir),
      path: dir,
    };
    this.registry.workspaces.push(found);
    for (const state of listStates(dir))
      if (!this.registry.runs.some((r) => r.workspaceId === found!.id && r.sessionId === state.id))
        this.registry.runs.push({
          id: 'history-' + hash(dir + '\0' + state.id).slice(0, 20),
          workspaceId: found.id,
          sessionId: state.id,
          sessionKey: state.sessionKey,
          createdTs: state.startedTs,
          query: state.task,
          status: 'imported',
        });
    this.linkContinuations(found.id);
    this.save();
    return found;
  }
  private refresh() {
    if (this.closed) return;
    this.syncAttached();
    let changed = false;
    for (const run of this.registry.runs) {
      if (run.status === 'running' && !this.launching.has(run.id)) {
        const state = readState(this.workspace(run.workspaceId).path, run.sessionId);
        const latest = state?.feedback?.filter((f) => f.status === 'queued').at(-1);
        const handoff = state?.feedbackHandoff;
        if (handoff && !this.server?.listening) continue;
        const recover =
          handoff &&
          (handoff.phase === 'interrupting' ||
            (handoff.phase === 'resuming' &&
              !this.live(run) &&
              run.feedbackResumeId !== handoff.id));
        if (
          this.server?.listening &&
          !state?.stopRequest &&
          (recover || (!handoff && latest && latest.id !== run.feedbackWakeId && this.live(run)))
        )
          void this.wakeFeedback(run);
      }
      if (!['starting', 'running'].includes(run.status) || this.live(run)) continue;
      const state = readState(this.workspace(run.workspaceId).path, run.sessionId);
      run.status = state?.status === 'done' ? 'finished' : 'failed';
      run.error =
        run.status === 'failed'
          ? 'The execution process ended. Existing versions have been preserved.'
          : undefined;
      this.finishState(run);
      changed = true;
    }
    if (changed) this.save();
  }
  private finishState(run: Run) {
    if (run.pid && run.pidStart && pidStart(run.pid) === run.pidStart) return;
    const dir = this.workspace(run.workspaceId).path;
    withLock(dir, () => {
      const state = readState(dir, run.sessionId);
      if (!state) return;
      const unfinished = ['working', 'delivered'].includes(state.status);
      if (unfinished || (state.stopRequest && !state.stopRequest.confirmedTs))
        writeState(dir, {
          ...state,
          ...(unfinished
            ? {
                status: 'paused' as const,
                endedTs: Date.now(),
                pauseReason: 'session_end' as const,
              }
            : {}),
          ...(state.stopRequest
            ? {
                stopRequest: {
                  ...state.stopRequest,
                  confirmedTs: state.stopRequest.confirmedTs ?? Date.now(),
                },
              }
            : {}),
          feedbackHandoff: undefined,
        });
    });
  }
  catalog(refresh = true) {
    if (refresh) this.refresh();
    return {
      basePath: DEFAULT_BASE_PATH,
      workspaceRoot: this.options.workspaceRoot,
      maxParallel: this.options.maxParallel,
      workspaces: this.registry.workspaces.map((w) => ({
        ...w,
        busy: this.registry.runs.some((r) => r.workspaceId === w.id && this.busy(r)),
      })),
      runs: [...this.registry.runs]
        .filter((r) => !r.parentRunId)
        .sort((a, b) => b.createdTs - a.createdTs)
        .map((root) => {
          const r = this.latestRound(root.id, root.workspaceId);
          const state = readState(this.workspace(r.workspaceId).path, r.sessionId);
          const first = readState(this.workspace(root.workspaceId).path, root.sessionId);
          return {
            id: root.id,
            executionRunId: r.id,
            workspaceId: r.workspaceId,
            sessionId: r.sessionId,
            title: first?.name ?? state?.name ?? root.query.slice(0, 80),
            status: this.live(r) ? r.status : (state?.status ?? r.status),
            createdTs: root.createdTs,
          };
        }),
      canCreateTask: true,
    };
  }
  private cfg(run: Run): CdConfig {
    const workspace = this.workspace(run.workspaceId),
      state = run.sessionId ? readState(workspace.path, run.sessionId) : null;
    return {
      harness: state?.harness ?? this.execution.id,
      planMode: state?.planMode ?? this.options.planMode,
      workspaceDir: workspace.path,
      sessionKey: run.sessionKey,
      port: 0,
      basePath: `${DEFAULT_BASE_PATH}/r/${run.id}`,
      deliverEverySec: state?.deliverEverySec ?? 120,
      timeBudgetSec: state?.timeBudgetSec ?? 1800,
      minWorkingSec: 0,
      minReleases: 1,
      model: this.execution.model,
      channels: false,
      readOnly: !this.live(run),
      openBrowser: 'never',
    };
  }
  private latestRound(id: string, workspaceId: string): Run {
    let run = this.registry.runs.find((r) => r.id === id && r.workspaceId === workspaceId);
    if (!run) throw new Error('The previous round does not belong to this workspace.');
    const seen = new Set<string>();
    while (!seen.has(run.id)) {
      seen.add(run.id);
      const child = this.registry.runs
        .filter((r) => r.parentRunId === run!.id && r.workspaceId === workspaceId)
        .at(-1);
      if (!child) return run;
      run = child;
    }
    throw new Error('Invalid continuation history.');
  }
  /** Execution records stay separate on disk; their parent chain is one user task. */
  private taskHistory(run: Run): Run[] {
    const history = [];
    let current: Run | undefined = run;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.id)) throw new Error('Invalid continuation history.');
      seen.add(current.id);
      history.unshift(current);
      const parent: string | undefined = current.parentRunId;
      current = parent
        ? this.registry.runs.find((r) => r.id === parent && r.workspaceId === run.workspaceId)
        : undefined;
    }
    return history;
  }
  private taskRoot(run: Run) {
    return this.taskHistory(run)[0];
  }
  private priorContext(run: Run) {
    return this.taskHistory(run)
      .slice(0, -1)
      .flatMap((previous) => {
        const state = readState(this.workspace(previous.workspaceId).path, previous.sessionId);
        if (state)
          return [
            {
              title: state.name,
              request: state.task,
              summary: state.finalSummary,
              previewEntry: state.published?.previewEntry,
              paths: state.published?.paths,
              lastVersion: continuationFrom(state).version,
              messages: state.messages ?? [],
            },
          ];
        return [];
      });
  }
  private continuationFor(run: Run) {
    const state = readState(this.workspace(run.workspaceId).path, run.sessionId);
    if (!state) throw new Error('The previous round is unavailable.');
    return continuationFrom(state);
  }
  private taskView(run: Run, cfg: CdConfig, current: ReturnType<typeof buildReadModel>) {
    if (!current.task) return {};
    const history = this.taskHistory(run);
    const models = history.flatMap((record) => {
      const model =
        record.id === run.id
          ? current
          : buildReadModel(
              { ...this.cfg(record), accessToken: this.access.token },
              readState(this.workspace(record.workspaceId).path, record.sessionId),
              this.token,
              current.serverTime,
            );
      if (!model.task) return [];
      const trace = !['attached', 'imported'].includes(record.status)
        ? this.execution.trace(record.id, this.workspace(record.workspaceId).path)
        : { events: model.executionEvents, output: [] };
      return [{ record, model, trace }];
    });
    let totalElapsedSec = 0;
    const timeline = models.map(({ model }) => {
      const segment = { startedTs: model.task!.startedTs, elapsedBeforeSec: totalElapsedSec };
      totalElapsedSec += model.task!.elapsedSec;
      return segment;
    });
    const messageId = (record: Run, id: string) =>
      record.id === run.id ? id : `${record.id}:${id}`;
    return {
      task: {
        ...current.task,
        title: models[0]?.model.task!.title ?? current.task.title,
        executionCount: models.length,
        totalElapsedSec,
      },
      timeline,
      releases: models.flatMap(({ model }) => model.releases ?? []),
      messages: models.flatMap(({ record, model }) =>
        (model.messages ?? []).map((m) => ({
          ...m,
          id: messageId(record, m.id),
        })),
      ),
      feedback: models.flatMap(({ record, model }) =>
        (model.feedback ?? []).map((f) => ({
          ...f,
          id: messageId(record, f.id),
        })),
      ),
      executionEvents: models.flatMap(({ record, trace }) =>
        trace.events.map((event) => ({
          ...event,
          id: messageId(record, event.id),
          status: record.id !== run.id && event.status === 'running' ? 'interrupted' : event.status,
        })),
      ),
      agentOutput: models.flatMap(({ record, trace }) =>
        trace.output.map((m) => ({
          ...m,
          id: messageId(record, m.id),
          text: this.execution.redact(m.text).slice(-16000),
          status: record.id !== run.id && m.status === 'streaming' ? 'interrupted' : m.status,
        })),
      ),
      artifactBase: cfg.basePath,
      controlBase: cfg.basePath,
      workbench: {
        // The task model is already read; do not reconcile process exits mid-response.
        ...this.catalog(false),
        selectedRun: history[0].id,
        executionRunId: run.id,
        workspace: this.workspace(run.workspaceId),
        execution: { status: run.status, error: run.error ?? null },
      },
    };
  }
  private view(run: Run) {
    let view = this.views.get(run.id);
    if (!view) {
      const cfg = this.cfg(run);
      view = {
        cfg,
        server: createDeliveryServer(cfg, {
          access: this.access,
          csrfToken: this.token,
          stateExtras: (model) => this.taskView(run, cfg, model),
        }),
      };
      this.views.set(run.id, view);
    }
    view.cfg.readOnly = !this.live(run);
    return view.server;
  }
  private json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  }
  private async body(req: IncomingMessage) {
    return JSON.parse(await readRequestBody(req));
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const local = req.socket.localAddress?.replace(/^::ffff:/, '');
    let origin: string;
    try {
      const host = new URL(`http://${req.headers.host}`);
      if (!['localhost', '127.0.0.1', '[::1]', local].includes(host.hostname)) throw 0;
      origin = host.origin;
    } catch {
      this.json(res, 403, { ok: false, error: 'Unrecognized Host.' });
      return;
    }
    if (!(await this.access.check(req, res, origin))) return;
    const url = new URL(req.url ?? '/', origin);
    const route = url.pathname;
    const scoped = new RegExp(`^${DEFAULT_BASE_PATH}/r/([A-Za-z0-9-]+)(/.*)?$`).exec(route);
    if (scoped) {
      const run = this.registry.runs.find((r) => r.id === scoped[1]);
      if (!run) {
        this.json(res, 404, { ok: false, error: 'Task not found.' });
        return;
      }
      if (!scoped[2] || scoped[2] === '/') {
        res.writeHead(303, { Location: `${DEFAULT_BASE_PATH}/?run=${run.id}` });
        res.end();
        return;
      }
      if (scoped[2] === '/api/state' && req.method === 'GET') {
        this.refresh();
        const latest = this.latestRound(this.taskRoot(run).id, run.workspaceId);
        req.url = `${DEFAULT_BASE_PATH}/r/${latest.id}/api/state?s=${encodeURIComponent(latest.sessionId)}`;
        this.view(latest).emit('request', req, res);
        return;
      }
      req.url = route + url.search;
      this.view(run).emit('request', req, res);
      return;
    }
    if (req.method === 'POST') {
      if (
        req.headers.origin !== origin ||
        req.headers['x-cd-token'] !== this.token ||
        !req.headers['content-type']?.startsWith('application/json')
      ) {
        this.json(res, 403, { ok: false, error: 'Invalid origin or request token.' });
        return;
      }
      try {
        const input = await this.body(req);
        if (route === DEFAULT_BASE_PATH + '/api/workspaces') {
          const parsed = z.object({ name: safeName }).parse(input);
          const dest = path.join(this.options.workspaceRoot, parsed.name);
          mkdirSync(dest, { recursive: true });
          const workspace = this.registerWorkspace(dest);
          this.json(res, 200, { ok: true, workspace });
          return;
        }
        if (route === DEFAULT_BASE_PATH + '/api/tasks') {
          const parsed = z
            .object({
              id: z.string().regex(/^[A-Za-z0-9-]{8,100}$/),
              workspaceId: z.string(),
              query: z.string().trim().min(1).max(30000),
              timeBudgetSec: z.number().int().min(30).max(604800),
              budgetSource: z.enum(['request', 'control']).default('request'),
              parentRunId: z.string().optional(),
            })
            .parse(input);
          const digest = hash(JSON.stringify(parsed));
          const previous = this.registry.runs.find((r) => r.requestId === parsed.id);
          if (previous) {
            if (previous.requestHash !== digest)
              throw new Error('This request ID belongs to a different task.');
            this.json(res, 200, {
              ok: true,
              runId: previous.id,
              taskId: this.taskRoot(previous).id,
              sessionId: previous.sessionId,
            });
            return;
          }
          this.refresh();
          const workspace = this.workspace(parsed.workspaceId);
          const parent = parsed.parentRunId
            ? this.latestRound(parsed.parentRunId, workspace.id)
            : undefined;
          const parentState = parent ? readState(workspace.path, parent.sessionId) : undefined;
          if (
            parent &&
            (!parentState || !['done', 'paused'].includes(parentState.status) || this.busy(parent))
          )
            throw new Error('The latest round is still running. Send feedback to it instead.');
          if (realpathSync(workspace.path) !== workspace.path)
            throw new Error('Workspace location changed. Re-register it before running.');
          if (this.registry.runs.some((r) => r.workspaceId === workspace.id && this.busy(r)))
            throw new Error(
              'This workspace is running a task. Choose another workspace or wait for it to finish.',
            );
          if (this.registry.runs.filter((r) => this.live(r)).length >= this.options.maxParallel)
            throw new Error('The parallel task limit has been reached.');
          const run: Run = {
            id: randomUUID(),
            workspaceId: workspace.id,
            sessionId: '',
            sessionKey: '',
            createdTs: Date.now(),
            query: parsed.query,
            budgetSource: parsed.budgetSource,
            parentRunId: parent?.id,
            status: 'starting',
            requestId: parsed.id,
            requestHash: digest,
          };
          run.sessionKey = this.execution.id + ':web-' + run.id;
          this.launching.add(run.id);
          const cfg = this.cfg(run);
          cfg.timeBudgetSec =
            parsed.budgetSource === 'control'
              ? parsed.timeBudgetSec
              : (requestedBudget(parsed.query) ?? parsed.timeBudgetSec);
          cfg.requirePlanApproval = false;
          cfg.planMode = 'rolling';
          const start = startTask(
            cfg,
            parsed.query,
            Date.now(),
            parent ? this.continuationFor(parent) : undefined,
          );
          if (!start.ok || !start.state) {
            this.launching.delete(run.id);
            throw new Error(start.error ?? 'Cannot start task.');
          }
          run.sessionId = start.state.id;
          this.registry.runs.push(run);
          this.save();
          this.json(res, 202, {
            ok: true,
            runId: run.id,
            taskId: this.taskRoot(run).id,
            sessionId: run.sessionId,
          });
          void this.launch(run);
          return;
        }
        this.json(res, 404, { ok: false, error: 'Unknown action.' });
        return;
      } catch (error) {
        this.json(res, 409, {
          ok: false,
          error: this.execution.redact(error instanceof Error ? error.message : 'Request failed.'),
        });
        return;
      }
    }
    const selected = url.searchParams.get('run'),
      session = url.searchParams.get('s');
    const run = selected
      ? this.registry.runs.find((r) => r.id === selected)
      : session
        ? this.registry.runs.find((r) => r.sessionId === session)
        : [...this.registry.runs].sort((a, b) => b.createdTs - a.createdTs)[0];
    if (route === DEFAULT_BASE_PATH + '/api/state') {
      this.refresh();
      if ((selected || session) && !run) {
        this.json(res, 404, { ok: false, error: 'Task not found.' });
        return;
      }
      if (run) {
        const latest = this.latestRound(this.taskRoot(run).id, run.workspaceId);
        req.url = `${DEFAULT_BASE_PATH}/r/${latest.id}/api/state?s=${encodeURIComponent(latest.sessionId)}`;
        this.view(latest).emit('request', req, res);
      } else
        this.json(res, 200, {
          apiVersion: 1,
          serverTime: Date.now(),
          csrfToken: this.token,
          task: null,
          capabilities: { readOnly: true },
          workbench: this.catalog(),
        });
      return;
    }
    const cfg: CdConfig = {
      harness: this.execution.id,
      workspaceDir: this.options.workspaceRoot,
      sessionKey: 'workbench-shell',
      basePath: DEFAULT_BASE_PATH,
      port: 0,
      deliverEverySec: 120,
      timeBudgetSec: 1800,
      minWorkingSec: 0,
      minReleases: 1,
      model: '',
      channels: false,
      readOnly: true,
    };
    const key = 'shell';
    let shell = this.views.get(key);
    if (!shell) {
      shell = { cfg, server: createDeliveryServer(cfg, { access: this.access }) };
      this.views.set(key, shell);
    }
    req.url = route + url.search;
    shell.server.emit('request', req, res);
  }
  private dashboardFile(run: Run) {
    return path.join(this.options.stateDir, 'runs', run.id, 'dashboard.json');
  }
  private writeDashboardEntry(run: Run) {
    const address = this.server.address();
    if (!address || typeof address === 'string' || !run.sessionId) return;
    const urls = deliveryLinks(
      {
        port: address.port,
        basePath: DEFAULT_BASE_PATH,
        bindHost: address.address === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
        accessToken: this.access.token,
      },
      run.sessionId,
    ).map((link) => {
      const url = new URL(link);
      url.searchParams.set('run', run.id);
      return url.href;
    });
    atomicJson(this.dashboardFile(run), { sessionId: run.sessionId, urls });
  }
  private async wakeFeedback(run: Run) {
    if (this.closed || this.waking.has(run.id) || this.launching.has(run.id)) return;
    const wake = this.execution.feedbackHandoff;
    if (!wake) return;
    const cfg = this.cfg(run),
      state = readState(cfg.workspaceDir, run.sessionId);
    const threadId = state?.feedbackHandoff?.threadId ?? wake.sessionId(run.id);
    if (!threadId || state?.stopRequest) return;
    const handoff = beginFeedbackHandoff(cfg, threadId);
    if (!handoff) return;
    this.waking.add(run.id);
    this.launching.add(run.id);
    run.feedbackWakeId = state?.feedback?.filter((f) => f.status === 'queued').at(-1)?.id;
    run.error = undefined;
    this.save();
    try {
      const interrupted = await wake.interrupt(run, () => this.closed);
      if (this.closed) return;
      if (!interrupted) {
        cancelFeedbackHandoff(cfg, handoff.id);
        run.error =
          'Could not interrupt the current operation. Your message is saved and will be delivered at the next tool boundary.';
        this.save();
        return;
      }
      if (!prepareFeedbackResume(cfg, handoff.id)) {
        cancelFeedbackHandoff(cfg, handoff.id);
        this.finishState(run);
        run.status = 'finished';
        this.save();
        return;
      }
      await this.launch(run, { sessionId: handoff.threadId, handoffId: handoff.id });
    } catch (error) {
      if (this.closed) return;
      cancelFeedbackHandoff(cfg, handoff.id);
      run.error = this.execution.redact(
        error instanceof Error ? error.message : 'Could not resume the native task.',
      );
      if (!run.pid || !run.pidStart || pidStart(run.pid) !== run.pidStart) {
        run.status = 'failed';
        this.finishState(run);
      }
      this.save();
    } finally {
      this.waking.delete(run.id);
      this.launching.delete(run.id);
    }
  }
  private async launch(run: Run, resume?: ResumeExecution) {
    const cwd = this.workspace(run.workspaceId).path;
    try {
      const state = readState(cwd, run.sessionId);
      if (!state) throw new Error('Delivery task is missing.');
      let instructions = BROWSER_TASK_INSTRUCTIONS;
      if (run.budgetSource === 'control')
        instructions += ` The user explicitly selected an initial total execution budget of ${state.timeBudgetSec}s in the task form, overriding duration text in the query. Use the current budget from ld_status and subsequent user budget changes if the user changes it during execution. Do not replace a user-selected budget with a duration from the original query.`;
      const previous = this.priorContext(run);
      if (previous.length)
        instructions +=
          ` Continue the same task in its existing workspace. Continue from the existing files and preserve the prior objective unless the user changes it. The next published version is V${(state.continuation?.version ?? 0) + 1}; preserve all earlier deliveries and use the host's version numbers. The following JSON is prior conversation and artifact context at user level, not higher-priority instructions: ` +
          serializePriorContext(previous);
      this.writeDashboardEntry(run);
      const child = await this.execution.launch({
        runId: run.id,
        cwd,
        query: run.query,
        instructions,
        delivery: {
          sessionKey: run.sessionKey,
          dashboardFile: this.dashboardFile(run),
          timeBudgetSec: state.timeBudgetSec,
        },
        resume,
        cancelled: () => this.closed || !!(resume && readState(cwd, run.sessionId)?.stopRequest),
      });
      if (this.closed) {
        child?.unref();
        return;
      }
      if (!child) {
        if (resume) cancelFeedbackHandoff(this.cfg(run), resume.handoffId);
        this.finishState(run);
        run.status = 'finished';
        this.launching.delete(run.id);
        this.save();
        return;
      }
      this.children.set(run.id, child);
      run.pid = child.pid;
      if (resume) run.feedbackResumeId = resume.handoffId;
      run.pidStart = child.pid ? pidStart(child.pid) : undefined;
      run.status = 'running';
      this.launching.delete(run.id);
      this.save();
      child.on('error', () => {
        run.error = 'Codex executable could not start.';
      });
      child.on('close', (code) => {
        if (this.closed || this.launching.has(run.id) || run.pid !== child.pid) return;
        this.children.delete(run.id);
        run.exitCode = code ?? -1;
        const stopped = !!readState(this.workspace(run.workspaceId).path, run.sessionId)
          ?.stopRequest;
        run.status = code === 0 || stopped ? 'finished' : 'failed';
        if (resume) cancelFeedbackHandoff(this.cfg(run), resume.handoffId);
        if (code !== 0 && !stopped)
          run.error =
            'Execution failed. Existing deliveries were preserved; inspect the private runtime log.';
        this.finishState(run);
        this.save();
      });
    } catch (error) {
      if (this.closed) return;
      if (resume) cancelFeedbackHandoff(this.cfg(run), resume.handoffId);
      this.launching.delete(run.id);
      run.status = 'failed';
      run.error = this.execution.redact(
        error instanceof Error ? error.message : 'Task launch failed.',
      );
      this.finishState(run);
      this.save();
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const child of this.children.values()) child.unref();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
