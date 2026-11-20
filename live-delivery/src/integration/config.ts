import path from 'node:path';
import { parseDurationSec } from '../delivery/engine.js';
import { requireSupportedPlatform } from '../shared/process.js';
import { DEFAULT_BASE_PATH, type CdConfig } from '../workbench/config.js';
import type { CliAdapter } from './cli-adapter.js';

export type CliConfig = Omit<CdConfig, 'sessionKey'> & {
  instance: string;
  sessionKey?: string;
};

export function loadConfig(adapter: CliAdapter, workspace?: string): CliConfig {
  requireSupportedPlatform();
  const env = process.env;
  const port = Number(env.QWEN_LD_PORT ?? adapter.defaultPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('QWEN_LD_PORT must be 0..65535.');
  const basePath = '/' + (env.QWEN_LD_BASE_PATH ?? DEFAULT_BASE_PATH).replace(/^\/+|\/+$/g, '');
  if (!/^\/[a-zA-Z0-9_/-]+$/.test(basePath)) throw new Error('Invalid QWEN_LD_BASE_PATH.');
  return {
    harness: adapter.id,
    workspaceDir: path.resolve(env.QWEN_LD_WORKSPACE || workspace || process.cwd()),
    instance: adapter.instance(),
    sessionKey: adapter.explicitSessionKey?.(),
    port,
    basePath,
    dashboardFile: env.QWEN_LD_DASHBOARD_FILE || undefined,
    bindHost:
      adapter.loopbackOnly || env.QWEN_LD_BIND_HOST === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
    openBrowser:
      env.QWEN_LD_OPEN_BROWSER === 'never'
        ? 'never'
        : env.QWEN_LD_OPEN_BROWSER === 'always'
          ? 'always'
          : 'auto',
    deliverEverySec: 120,
    timeBudgetSec: Math.max(1, parseDurationSec(env.QWEN_LD_TIME_BUDGET, 1800)),
    minWorkingSec: 0,
    minReleases: 1,
    requirePlanApproval: false,
    planMode: 'rolling',
    model: env.QWEN_LD_MODEL || adapter.model(),
    channels: false,
  };
}
