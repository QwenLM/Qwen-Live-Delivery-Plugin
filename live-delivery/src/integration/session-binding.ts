import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cdRootDir } from '../delivery/state.js';
import { withLock } from '../delivery/lock.js';
import { atomicJson, readJson } from '../shared/json.js';
import type { CdConfig } from '../workbench/config.js';
import type { CliConfig } from './config.js';
import type { CliHookEvent } from './cli-adapter.js';

type Binding = { sessionKey: string; model?: string; conflicting?: boolean };
type HostBinding = Binding & { workspaceDir: string };

export class SessionBindingError extends Error {
  constructor(
    readonly kind: 'missing' | 'ambiguous',
    message: string,
  ) {
    super(message);
  }
}

function identity(cfg: CliConfig): string {
  return `${cfg.harness}-${createHash('sha256').update(cfg.instance).digest('hex').slice(0, 20)}`;
}

function runtimeFile(cfg: CliConfig, suffix: string): string {
  return path.join(cdRootDir(cfg.workspaceDir), '_runtime', `${identity(cfg)}.${suffix}.json`);
}

function hostFile(cfg: CliConfig): string {
  const dir = path.join(
    os.tmpdir(),
    `live-delivery-host-${process.getuid?.() ?? os.userInfo().username}`,
  );
  return path.join(dir, `${identity(cfg)}.json`);
}

export function locateWorkspace(cfg: CliConfig): CliConfig | null {
  if (process.env.QWEN_LD_WORKSPACE) return cfg;
  const host = readJson<HostBinding>(hostFile(cfg));
  if (host?.conflicting) throw ambiguousSession();
  return host?.workspaceDir ? { ...cfg, workspaceDir: host.workspaceDir } : null;
}

function ambiguousSession() {
  return new SessionBindingError(
    'ambiguous',
    'CD session binding is ambiguous. Use a separate CLI process for each conversation.',
  );
}

export function bindSession(
  cfg: CliConfig,
  event: Pick<CliHookEvent, 'sessionId' | 'model' | 'replacesSession'>,
): boolean {
  return withLock(cfg.workspaceDir, () => {
    const sessionKey = `${cfg.harness}:${event.sessionId}`;
    const file = runtimeFile(cfg, 'binding');
    const previous = readJson<Binding>(file);
    const host = readJson<HostBinding>(hostFile(cfg));
    const conflicting =
      !event.replacesSession &&
      !!(
        previous?.conflicting ||
        (previous && previous.sessionKey !== sessionKey) ||
        host?.conflicting ||
        (host && (host.sessionKey !== sessionKey || host.workspaceDir !== cfg.workspaceDir))
      );
    const model = event.model ?? (previous?.sessionKey === sessionKey ? previous.model : undefined);
    if (
      previous?.sessionKey !== sessionKey ||
      previous?.conflicting !== conflicting ||
      previous?.model !== model
    )
      atomicJson(file, { sessionKey, model, conflicting } satisfies Binding);
    if (
      host?.sessionKey !== sessionKey ||
      host?.conflicting !== conflicting ||
      host?.workspaceDir !== cfg.workspaceDir
    ) {
      mkdirSync(path.dirname(hostFile(cfg)), { recursive: true, mode: 0o700 });
      atomicJson(hostFile(cfg), {
        workspaceDir: cfg.workspaceDir,
        sessionKey,
        conflicting,
      } satisfies HostBinding);
    }
    return !conflicting;
  });
}

export function resolveSession(cfg: CliConfig): CdConfig {
  const binding = readJson<Binding>(runtimeFile(cfg, 'binding'));
  const model = process.env.QWEN_LD_MODEL || (!binding?.conflicting && binding?.model) || cfg.model;
  if (cfg.sessionKey) return { ...cfg, model, sessionKey: cfg.sessionKey };
  const host = readJson<HostBinding>(hostFile(cfg));
  if (
    binding?.conflicting ||
    host?.conflicting ||
    (binding &&
      host &&
      (host.sessionKey !== binding.sessionKey || host.workspaceDir !== cfg.workspaceDir))
  )
    throw ambiguousSession();
  if (!binding || !host) throw missingSession();
  return { ...cfg, model, sessionKey: binding.sessionKey };
}

export function missingSession() {
  return new SessionBindingError(
    'missing',
    'No CD session binding. Enable the plugin session hooks and start a new session.',
  );
}

export function persistDashboard(cfg: CliConfig): void {
  atomicJson(runtimeFile(cfg, 'config'), cfg);
}

export function readBoundModel(cfg: CliConfig, nativeSessionId: string): string | undefined {
  const binding = readJson<Binding>(runtimeFile(cfg, 'binding'));
  if (!binding?.conflicting && binding?.sessionKey === `${cfg.harness}:${nativeSessionId}`)
    return binding.model;
}

export function readDashboard(cfg: CdConfig & { instance: string }): CdConfig {
  const saved = readJson<CliConfig>(runtimeFile(cfg, 'config'));
  return saved
    ? {
        ...cfg,
        port: saved.port,
        accessToken: saved.accessToken,
      }
    : cfg;
}
