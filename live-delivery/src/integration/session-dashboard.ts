import type { CliConfig } from './config.js';
import type { CdConfig } from '../workbench/config.js';
import { createDeliveryServer } from '../workbench/http.js';

export function sessionDashboard(cfg: CliConfig, resolveConfig: () => CdConfig) {
  const initial = { ...cfg, sessionKey: cfg.sessionKey ?? '' };
  const server = createDeliveryServer(initial, { resolveConfig });
  cfg.accessToken = initial.accessToken;
  return {
    server,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
