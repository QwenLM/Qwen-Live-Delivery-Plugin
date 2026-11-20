import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configForServer, loadConfig, persistConfig, type CdConfig } from './config.js';
import { runDeadlineTick } from './core.js';
import { openDeliveryOnce, deliveryLinks } from './browser.js';
import { createDeliveryServer } from './http.js';
import { callTool, TOOL_DESCRIPTIONS, TOOL_SCHEMAS, type ToolName } from './tools.js';
import { WorkbenchHost } from './workbench-host.js';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const seed = loadConfig();
const log = (s: string) => process.stderr.write(`[live-delivery ${seed.harness}] ${s}\n`);
const mcp = new McpServer({ name: 'live-delivery', version: '0.1.0' });
let cfg: CdConfig | undefined;
let http: ReturnType<typeof createDeliveryServer> | undefined;
let workbench: WorkbenchHost | undefined;
let initializing: Promise<CdConfig> | undefined;
let closing = false;

// Finish the MCP handshake before waiting for SessionStart. Some hosts start
// MCP first; others run hooks first. Both orders must work without deadlocking.
async function initializeRuntime(): Promise<CdConfig> {
  if (cfg) return cfg;
  if (initializing) return initializing;
  const resolved = configForServer(seed);
  if (!resolved)
    throw new Error(
      'No CD session binding. Enable the plugin SessionStart/UserPromptSubmit hooks and start a new session.',
    );
  initializing = (async () => {
    if (process.env.QWEN_LD_EMBEDDED_TASK === '1') http = createDeliveryServer(resolved);
    else {
      // The harness's own config directory holds the private workbench state
      // and is never selectable as a workspace.
      const home =
        resolved.harness === 'claude-code'
          ? (process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'))
          : (process.env.CODEX_HOME ?? path.join(homedir(), '.codex'));
      const owner = createHash('sha256').update(resolved.instance).digest('hex').slice(0, 16);
      workbench = new WorkbenchHost({
        harness: resolved.harness,
        stateDir:
          process.env.QWEN_LD_WORKBENCH_STATE ??
          path.join(home, 'live-delivery', 'workbenches', owner),
        workspaceRoot:
          process.env.QWEN_LD_WORKSPACE_ROOT ?? path.join(homedir(), 'live-delivery-workspaces'),
        pluginRoot: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
        codexHome: home,
        codexBin: process.env.CODEX_BIN,
        importWorkspaces: [resolved.workspaceDir],
        sandbox:
          process.env.QWEN_LD_TASK_SANDBOX === 'danger-full-access'
            ? 'danger-full-access'
            : 'workspace-write',
      });
      resolved.accessToken = workbench.access.token;
      workbench.attachSession(resolved);
      http = workbench.server;
    }
    await new Promise<void>((resolve, reject) => {
      let attempts = 0;
      const listen = () => http!.listen(resolved.port, resolved.bindHost ?? '0.0.0.0');
      http!.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && attempts++ < 15 && resolved.port < 65535) {
          resolved.port++;
          setImmediate(listen);
        } else reject(e);
      });
      http!.once('listening', () => {
        const addr = http!.address();
        if (addr && typeof addr === 'object') resolved.port = addr.port;
        persistConfig(resolved);
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
        const cfg = await initializeRuntime();
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
    const cfg = await initializeRuntime();
    runDeadlineTick(cfg);
    openDeliveryOnce(cfg, log);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('No CD session binding'))
      log(String(error));
  }
}, 1000);
timer.unref();
const transport = new StdioServerTransport();
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  if (workbench) await workbench.close();
  else {
    http?.closeAllConnections();
    http?.close();
  }
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
