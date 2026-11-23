/** Read-only replay after the native CLI exits; no model/config/credentials loaded. */
import { parseArgs } from 'node:util';
import path from 'node:path';
import { createDeliveryServer } from './http.js';
import { readState } from '../delivery/state.js';
import { DEFAULT_BASE_PATH, type CdConfig } from './config.js';
import { sessionUrl } from './browser.js';

const { values } = parseArgs({
  options: {
    workspace: { type: 'string' },
    session: { type: 'string' },
    port: { type: 'string', default: '18791' },
    host: { type: 'string', default: '127.0.0.1' },
  },
});
if (!values.workspace || !values.session)
  throw new Error(
    'Usage: node dist/viewer.mjs --workspace /absolute/workspace --session cd-id [--port 18791] [--host 0.0.0.0]',
  );
const workspaceDir = path.resolve(values.workspace),
  state = readState(workspaceDir, values.session);
if (!state) throw new Error('Delivery session not found.');
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
if (!['127.0.0.1', '0.0.0.0'].includes(values.host!))
  throw new Error('Use a loopback address or explicit 0.0.0.0 for sharing.');
const cfg: CdConfig = {
  harness: state.harness ?? 'codex',
  workspaceDir,
  sessionKey: state.sessionKey,
  port,
  basePath: DEFAULT_BASE_PATH,
  deliverEverySec: state.deliverEverySec,
  timeBudgetSec: state.timeBudgetSec,
  minWorkingSec: 0,
  minReleases: 1,
  model: '',
  channels: false,
  readOnly: true,
};
const server = createDeliveryServer(cfg);
server.listen(port, values.host, () => {
  const addr = server.address();
  if (addr && typeof addr === 'object') cfg.port = addr.port;
  process.stdout.write(`Read-only delivery record: ${sessionUrl(cfg, state.id)}\n`);
});
