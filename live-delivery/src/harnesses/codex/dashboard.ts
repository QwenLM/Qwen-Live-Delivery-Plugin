import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { CliConfig } from '../../integration/config.js';
import { SessionBindingError } from '../../integration/session-binding.js';
import type { CdConfig } from '../../workbench/config.js';
import { WorkbenchHost, type WorkbenchOptions } from '../../workbench/workbench-host.js';
import { CodexExecution, type CodexOptions } from './execution.js';

export function createCodexWorkbench(input: WorkbenchOptions & CodexOptions, env = process.env) {
  return new WorkbenchHost(
    input,
    (stateDir) =>
      new CodexExecution(stateDir, { ...input, pluginRoot: realpathSync(input.pluginRoot) }, env),
  );
}

export function codexDashboard(cfg: CliConfig, resolveConfig: () => CdConfig) {
  const home = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  const owner = createHash('sha256').update(cfg.instance).digest('hex').slice(0, 16);
  const workbench = createCodexWorkbench({
    stateDir:
      process.env.QWEN_LD_WORKBENCH_STATE ?? path.join(home, 'live-delivery', 'workbenches', owner),
    workspaceRoot:
      process.env.QWEN_LD_WORKSPACE_ROOT ?? path.join(homedir(), 'live-delivery-workspaces'),
    pluginRoot: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    codexHome: home,
    codexBin: process.env.CODEX_BIN,
    importWorkspaces: [cfg.workspaceDir],
    sandbox:
      process.env.QWEN_LD_TASK_SANDBOX === 'danger-full-access'
        ? 'danger-full-access'
        : 'workspace-write',
  });
  cfg.accessToken = workbench.access.token;
  workbench.attachSession(() => {
    try {
      return resolveConfig();
    } catch (error) {
      if (!(error instanceof SessionBindingError)) throw error;
      return undefined;
    }
  });
  return { server: workbench.server, close: () => workbench.close() };
}
