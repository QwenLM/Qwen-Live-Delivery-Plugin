import { parseArgs } from 'node:util';
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { configurePluginHooks } from './hook-trust.js';
import { requireSupportedPlatform } from '../../shared/process.js';
import { sandboxWarnings } from './setup-diagnostics.js';
import { configuredProviderEnv, configureProviderEnv } from './provider-env.js';
import { stagePlugin } from './plugin-package.js';

const { values } = parseArgs({
  options: {
    yes: { type: 'boolean' },
    'install-only': { type: 'boolean' },
    doctor: { type: 'boolean' },
    workspace: { type: 'string' },
  },
});
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checkout =
  path.basename(root) === 'live-delivery' &&
  existsSync(path.join(root, '../.agents/plugins/marketplace.json'))
    ? path.dirname(root)
    : root;
const home = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
const bin = process.env.CODEX_BIN ?? 'codex';
const selector = 'ld@live-delivery-local';
const version = JSON.parse(
  readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'),
).version;
const line = (text: string) => process.stdout.write(text + '\n');
function command(args: string[]) {
  const result = spawnSync(bin, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.status !== 0)
    throw new Error(
      `Codex ${args.slice(0, 3).join(' ')} failed. Check that codex --version and codex plugin list work, then retry.`,
    );
  return result.stdout;
}
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
async function main() {
  requireSupportedPlatform();
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required.');
  const cli = command(['--version']).trim();
  line(`持续交付 / Live Delivery ${version}\n${cli} · Node ${process.versions.node}`);
  line(
    '\n安装不会更改 Codex 的沙箱或审批配置。CLI 沿用现有设置；网页新任务默认使用 workspace-write 沙箱。\nInstallation preserves Codex sandbox and approval settings. CLI tasks keep their current settings; browser-created tasks default to workspace-write.',
  );
  const warnings = sandboxWarnings();
  for (const warning of warnings) line(`\n${warning.message}`);
  const workspace = path.resolve(
    values.workspace ??
      (process.cwd() === root || process.cwd() === checkout
        ? path.join(homedir(), 'live-delivery-workspaces', 'first-task')
        : process.cwd()),
  );
  if (!values.doctor) {
    line(
      '\n将安装 ld 插件，并仅启用本插件的 6 项 hooks（会话绑定、反馈、交付收尾）。\nInstalls ld and enables only its six session/feedback/delivery hooks. Existing model credentials stay on this machine.',
    );
    if (!values.yes) {
      if (!process.stdin.isTTY)
        throw new Error('Use --yes --install-only for an unattended installation.');
      const input = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await input.question(
        '按 Enter 安装并启用 / Enter to install and enable, n to cancel: ',
      );
      input.close();
      if (answer.trim() && !/^(y|yes)$/i.test(answer.trim())) return;
    }
    const providerEnv = await configuredProviderEnv(
      existsSync(workspace) ? workspace : process.cwd(),
      process.env,
      bin,
    );
    const installHash = createHash('sha256')
      .update(digest(path.join(root, 'dist/server.mjs')))
      .update(JSON.stringify(providerEnv))
      .digest('hex');
    const stable = path.join(
      home,
      'live-delivery',
      'packages',
      `${version}-${installHash.slice(0, 12)}`,
    );
    stagePlugin(root, stable);
    configureProviderEnv(stable, providerEnv);
    const marketplaces = JSON.parse(command(['plugin', 'marketplace', 'list', '--json'])) as {
      marketplaces: Array<{ name: string; root: string }>;
    };
    const previous = marketplaces.marketplaces.find((item) => item.name === 'live-delivery-local');
    if (previous && path.resolve(previous.root) !== path.resolve(stable))
      command(['plugin', 'marketplace', 'remove', 'live-delivery-local', '--json']);
    command(['plugin', 'marketplace', 'add', stable, '--json']);
    command(['plugin', 'add', selector, '--json']);
    line('✓ 插件已安装 / Plugin installed');
  }
  if (!values.doctor) {
    mkdirSync(workspace, { recursive: true });
    const canonical = realpathSync(workspace);
    for (const privateRoot of [checkout, home]) {
      if (!existsSync(privateRoot)) continue;
      const relative = path.relative(realpathSync(privateRoot), canonical);
      if (
        relative === '' ||
        (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
      )
        throw new Error(
          'Choose a workspace outside the plugin and Codex configuration directories with --workspace.',
        );
    }
  }
  await configurePluginHooks(
    root,
    existsSync(workspace) ? workspace : process.cwd(),
    process.env,
    bin,
    { readOnly: !!values.doctor },
  );
  line('✓ 6 / 6 hooks 已启用并通过内容校验 / Hooks enabled and trusted');
  line(
    warnings.length
      ? '注意：上述沙箱警告仍需处理。hook 检查成功不代表任务可以执行。\nSandbox warnings remain. Successful hook checks do not verify task execution.'
      : '此检查不执行模型任务，也不验证沙箱可用性。\nThis check does not run a model task or verify sandbox execution.',
  );
  line(
    '\n下一步 / Next:\n  1. 在 Codex 输入 / Enter: $ld:go 你的需求\n  2. 打开提示中的工作台链接；直接开始交付 / Open the printed dashboard link; delivery starts automatically\n  3. 网页查看版本、下载成果、追加要求 / Preview, download, and send feedback\n\n默认监听 0.0.0.0，启动后会显示本机和服务器 IP 地址。Use the printed server IP from another computer.',
  );
  if (values.doctor || values['install-only']) return;
  line(`\n工作区 / Workspace: ${workspace}\n正在启动 Codex / Starting Codex…`);
  const child = spawn(bin, ['--cd', workspace, '--enable', 'hooks'], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  child.on('error', () => {
    line('Could not start Codex. Run codex in your workspace.');
    process.exitCode = 1;
  });
}
main().catch((error) => {
  process.stderr.write(
    `\n安装检查未通过 / Setup needs attention: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
