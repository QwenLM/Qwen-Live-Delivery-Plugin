/** Optional local process host for starting native Codex tasks from the browser. */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import { createCodexWorkbench } from './dashboard.js';
import { deliveryLinks } from '../../workbench/browser.js';
import { DEFAULT_BASE_PATH } from '../../workbench/config.js';
const { values } = parseArgs({
  options: {
    'workspace-root': { type: 'string' },
    'state-dir': { type: 'string' },
    'codex-home': { type: 'string' },
    'codex-bin': { type: 'string' },
    'import-workspace': { type: 'string', multiple: true },
    port: { type: 'string', default: '18791' },
    host: { type: 'string', default: '0.0.0.0' },
    sandbox: { type: 'string', default: 'workspace-write' },
  },
});
if (!values['workspace-root'])
  throw new Error(
    'Usage: node dist/workbench.mjs --workspace-root /your/workspaces [--import-workspace /existing/project] [--port 18791]',
  );
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
if (!['127.0.0.1', '0.0.0.0'].includes(values.host!))
  throw new Error('Use loopback or explicit 0.0.0.0.');
if (!['workspace-write', 'danger-full-access'].includes(values.sandbox!))
  throw new Error('Invalid sandbox.');
const host = createCodexWorkbench({
  workspaceRoot: values['workspace-root'],
  stateDir: values['state-dir'] ?? path.join(homedir(), '.local/state/live-delivery'),
  pluginRoot: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  codexHome: values['codex-home'],
  codexBin: values['codex-bin'],
  importWorkspaces: values['import-workspace'],
  sandbox: values.sandbox as 'workspace-write' | 'danger-full-access',
});
host.server.listen(port, values.host, () => {
  const address = host.server.address();
  if (address && typeof address === 'object')
    process.stdout.write(
      `👉 Live Delivery workbench / 持续交付工作台\n${deliveryLinks({ port: address.port, basePath: DEFAULT_BASE_PATH, bindHost: values.host, accessToken: host.access.token }).join('\n')}\n`,
    );
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    void host.close().then(() => process.exit(0));
  });
