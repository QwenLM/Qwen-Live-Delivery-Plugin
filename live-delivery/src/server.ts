import { runMcp, type DashboardFactory } from './integration/server.js';
import { sessionDashboard } from './integration/session-dashboard.js';
import { cliAdapter } from './harnesses/cli-entry.js';
import { codexDashboard } from './harnesses/codex/dashboard.js';

const hostedDashboards: Partial<Record<string, DashboardFactory>> = { codex: codexDashboard };
const dashboard =
  process.env.QWEN_LD_EMBEDDED_TASK === '1'
    ? sessionDashboard
    : (hostedDashboards[cliAdapter.id] ?? sessionDashboard);

await runMcp(cliAdapter, dashboard);
