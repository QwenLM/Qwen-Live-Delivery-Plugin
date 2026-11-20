import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type CliConfig } from './config.js';
import {
  locateWorkspace,
  missingSession,
  persistDashboard,
  resolveSession,
  SessionBindingError,
} from './session-binding.js';
import type { CliAdapter } from './cli-adapter.js';
import type { CdConfig } from '../workbench/config.js';
import { runDeadlineTick } from '../delivery/core.js';
import { openDeliveryOnce, deliveryLinks } from '../workbench/browser.js';
import { callTool, TOOL_DESCRIPTIONS, TOOL_SCHEMAS, type ToolName } from './tools.js';
import type { Server } from 'node:http';

type Dashboard = { server: Server; close: () => void | Promise<void> };
export type DashboardFactory = (cfg: CliConfig, scope: () => CdConfig) => Dashboard;

export async function runMcp(adapter: CliAdapter, createDashboard: DashboardFactory) {
  const seed = loadConfig(adapter);
  const log = (s: string) => process.stderr.write(`[live-delivery ${seed.harness}] ${s}\n`);
  const mcp = new McpServer({ name: 'live-delivery', version: '0.1.0' });
  let cfg: CliConfig | undefined;
  let dashboard: Dashboard | undefined;
  let initializing: Promise<CliConfig> | undefined;
  let closing = false;

  // Finish the MCP handshake before waiting for SessionStart. Some hosts start
  // MCP first; others run hooks first. Both orders must work without deadlocking.
  async function initializeRuntime(): Promise<CliConfig> {
    if (cfg) return cfg;
    if (initializing) return initializing;
    const resolved = locateWorkspace(seed);
    if (!resolved) throw missingSession();
    initializing = (async () => {
      dashboard = createDashboard(resolved, () => resolveSession(resolved));
      const http = dashboard.server;
      await new Promise<void>((resolve, reject) => {
        let attempts = 0;
        const listen = () => http.listen(resolved.port, resolved.bindHost ?? '0.0.0.0');
        http.on('error', (e: NodeJS.ErrnoException) => {
          if (e.code === 'EADDRINUSE' && attempts++ < 15 && resolved.port < 65535) {
            resolved.port++;
            setImmediate(listen);
          } else reject(e);
        });
        http.once('listening', () => {
          const addr = http.address();
          if (addr && typeof addr === 'object') resolved.port = addr.port;
          persistDashboard(resolved);
          log(`Delivery page: ${deliveryLinks(resolved)[0]}`);
          log(`👉 持续交付工作台 / Delivery dashboard: ${deliveryLinks(resolved).join(' | ')}`);
          resolve();
        });
        listen();
      });
      cfg = resolved;
      return cfg;
    })();
    try {
      return await initializing;
    } catch (e) {
      initializing = undefined;
      throw e;
    }
  }
  for (const name of Object.keys(TOOL_SCHEMAS) as ToolName[]) {
    mcp.registerTool(
      name,
      {
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: TOOL_SCHEMAS[name],
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (p: unknown) => {
        try {
          const cfg = resolveSession(await initializeRuntime());
          const result = callTool(cfg, name, p);
          openDeliveryOnce(cfg, log);
          return result;
        } catch (e) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
          };
        }
      },
    );
  }
  const timer = setInterval(async () => {
    if (closing) return;
    try {
      const cfg = resolveSession(await initializeRuntime());
      runDeadlineTick(cfg);
      openDeliveryOnce(cfg, log);
    } catch (error) {
      if (!(error instanceof SessionBindingError) || error.kind !== 'missing') log(String(error));
    }
  }, 1000);
  timer.unref();
  const transport = new StdioServerTransport();
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    await dashboard?.close();
    await mcp.close();
  }
  mcp.server.onclose = () => {
    void close();
  };
  process.stdin.on('end', () => {
    void close();
  });
  process.on('SIGINT', () => {
    void close();
  });
  process.on('SIGTERM', () => {
    void close();
  });
  await mcp.connect(transport);
}
