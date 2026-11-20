# 开发与测试

[English](development.md) · **中文** · [返回 README](../README.zh-CN.md)

使用源码检出目录、Node.js 22+ 和 npm。从仓库根目录进入 `live-delivery/`，后续命令均在其中运行。

运行时面向 macOS 和 Linux。Linux 使用进程启动 tick 识别任务进程，macOS 使用固定语言环境下 BSD `ps` 的状态与启动时间。原生 Windows 会在安装或任务宿主启动前被拒绝。

GitHub 使用 `.github/workflows/test.yml` 在 Linux 和 macOS 上运行检查，使用本地测试样例，无需模型认证信息。Linux 测试通过不能代表 macOS 通过；发布支持平台的验证结论前，需要记录各平台的实际运行环境和结果。

```bash
cd live-delivery
npm ci
npm run verify
```

`verify` 会构建运行文件、检查 TypeScript、运行离线回归测试，并校验发布元数据、文档链接和运行包文件清单。它不会调用模型或使用 API key。`npm run format:check` 检查格式，`npm run format` 应用格式化。

## 源码结构

| 路径                                               | 内容                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `.agents/plugins/marketplace.json`                 | 仓库安装索引，指向 `live-delivery/`                               |
| `live-delivery/.codex-plugin/plugin.json`          | Codex 插件清单                                                    |
| `.claude-plugin/marketplace.json`                  | Claude Code 插件市场，指向 `live-delivery/claude-code/`           |
| `live-delivery/claude-code/`                       | Claude Code 插件根目录：清单、`.mcp.json`、hooks 和生成的运行文件 |
| `live-delivery/src/`                               | MCP 服务、hook、状态、发布、控制与 HTTP 工作台宿主                |
| `live-delivery/ui/`                                | 网页界面与随包提供的本地资源                                      |
| `live-delivery/skills/`                            | `$ld:go` 的交付指令和 `$ld:install` 的安装指引                    |
| `live-delivery/src/prompts/tool-descriptions.json` | MCP 工具描述的源文件                                              |
| `live-delivery/test/`                              | 协议、快照、生命周期、原生 Codex 与浏览器检查                     |
| `live-delivery/scripts/`                           | 构建、发布检查、打包和依赖声明生成                                |
| `live-delivery/dist/`                              | 构建生成的独立运行文件                                            |
| `docs/`                                            | 公开文档、配图和演示素材                                          |

安装索引和插件清单是安装所需元数据，不是缓存。`.github/`、README 和治理文件保留在仓库根目录；构建与依赖配置放在 `live-delivery/`。

不要手动修改 `live-delivery/` 中的 `src/*.generated.ts` 或 `dist/`。源码变更时一起提交生成的运行文件，确保发行包无需安装依赖即可使用。构建会重新生成 UI 资源，将根目录 `LICENSE` 复制到插件中，并将依赖许可证原文写入 `dist/` 注释。私有实验、模型对话、产品方案与密钥请放在仓库之外。

首版使用 `QWEN_LD_PROTOCOL = 'v1'` 和 `stateVersion: 1`，仅接受这一状态格式；插件不包含原型格式的转换逻辑。交付成果的版本号独立递增，不随协议版本重置。

`docs/` 中的使用指南保留英文和 `.zh-CN.md` 中文版本；贡献、安全文档仅保留英文。修改配置、命令或行为说明时同步两版，保留页首语言切换链接。JSON 字段与可执行命令保持一致，不翻译为另一套接口。

## 打包试用

```bash
npm run package -- --out ./release
mkdir -p ./release/unpacked
tar -xzf ./release/qwen-live-delivery-codex-0.1.0.tgz -C ./release/unpacked
./release/unpacked/package/live-delivery/install.sh --install-only --workspace /path/to/project
```

在**另一个项目目录**新开 Codex 会话。请通过 `install.sh` 安装，即使从源码目录执行，它也只会安装运行所需文件。直接用 `codex plugin marketplace add` 注册开发根目录，可能一并复制依赖和测试产物，请避免这种安装方式。

`package.json`、`package-lock.json` 和 `tsconfig.json` 放在 `live-delivery/` 中，分别定义 Node.js 项目、可复现的依赖版本与 TypeScript 配置。`src/prompts/` 是构建输入，`dist/` 是安装时使用的运行文件。仓库保留 `dist/`，以便源码检出后无需开发构建也能安装。

npm 包有意设置为 `private: true`。打包脚本将白名单内的插件文件、根目录文档和安装索引组合成发行包，保留 `live-delivery/` 层级，不含源码、测试和依赖目录。本项目不向 npm registry 发布。

## 原生 Codex 兼容性

安装需要验证的 CLI 版本后运行：

```bash
node test/setup-native.mjs
node test/provider-env-native.mjs
node test/workbench-native.mjs
QWEN_LD_TEST_FEEDBACK=1 node test/workbench-native.mjs
npm run test:codex
```

通过 `CODEX_BIN` 指定 CLI 可执行文件，通过 `QWEN_LD_TEST_PACKAGE` 指定解压后的 `package/live-delivery/` 目录，以验证该包而非开发运行文件。测试不会修改日常 Codex 配置或已安装插件。真实模型评估需要另行手动发起，会消耗操作者自己的额度。

## Claude Code 适配

`npm run build` 从同一份源码构建两个适配；`node scripts/build.mjs codex` 或 `node scripts/build.mjs claude-code` 只构建其中一个。Harness 在构建时通过 `QWEN_LD_HARNESS` 固定。Claude Code 插件根目录 `live-delivery/claude-code/` 中有三个手写文件（`.claude-plugin/plugin.json`、`.mcp.json`、`hooks/hooks.json`），其余由构建生成：`dist/server.mjs`、`dist/hook.mjs`，以及复制的 `skills/go/SKILL.md` 和 `LICENSE`。与 Codex 的 `dist/` 一样，生成文件需与源码一起提交。Codex 发行包不包含 `claude-code/`；Claude Code 通过仓库插件市场安装。

`test/claude-code.test.mjs` 和 `test/transport.test.mjs` 中的 `claude-code` 用例离线覆盖插件结构、hook 协议、对话记录用量统计，以及仅支持命令行任务的工作台。如需在不影响日常设置的情况下用真实 Claude Code CLI 检查插件：

```bash
claude plugin validate ..
export CLAUDE_CONFIG_DIR="$(mktemp -d)"
claude plugin marketplace add ..
claude plugin install ld@qwen-live-delivery
(cd "$(mktemp -d)" && claude mcp list)   # 应显示 plugin:ld:live-delivery 已连接
```

真实的 `/ld:go` 会话需要已登录的 Claude Code，并消耗操作者自己的额度。请记录 Claude Code 版本和所用模型。

## 浏览器检查

Python 3 和 Playwright 是可选开发依赖：

```bash
python3 -m venv .venv
.venv/bin/pip install -r test/requirements.txt
.venv/bin/python -m playwright install chromium
.venv/bin/python test/simple-browser.py artifacts/workbench
```

`CHROMIUM_PATH` 可指定已有 Chromium 可执行文件。测试使用临时本地工作区和行为固定的子任务，不操作正在运行的任务。截图与报告写入指定输出目录，不会进入发行包。覆盖任务控制、交付物隔离、工作区切换、后续轮次、只读版本卡片与待交付目标、时间单位换算、键盘与输入法操作、执行状态、桌面和手机上的停止按钮、新手指引定位，以及记住不再提示的选择。

手动检查还应使用真实任务走完整流程：直接开始、在聊天里调整下一版、检查两个不同版本、发送反馈、下载 ZIP、请求停止收尾。记录 Codex 版本和使用的模型、服务商，不能根据固定响应测试推断真实模型质量。

## 发布

将 skill、hooks、MCP 服务和工作台作为同一个包验证和发布。

1. 同步 `package.json`、`package-lock.json`、`.codex-plugin/plugin.json`、`claude-code/.claude-plugin/plugin.json`、`../.claude-plugin/marketplace.json`、`src/core.ts`、`src/server.ts` 和 `src/native-rpc.ts` 中的版本号，并更新双语文档中的压缩包示例。
2. 在干净的代码检出中运行 `npm ci`、`npm run verify`、`npm run format:check` 和 `npm audit`，再运行[原生 Codex 检查](#原生-codex-兼容性)。Linux 和 macOS 检查均应通过；UI 变更还需运行[浏览器检查](#浏览器检查)。记录实际测试的 Node.js 和 Codex 版本。
3. 按[打包试用](#打包试用)生成并解压运行包，再验证解压后的包：

   ```bash
   QWEN_LD_TEST_PACKAGE="$PWD/release/unpacked/package/live-delivery" node test/setup-native.mjs
   QWEN_LD_TEST_PACKAGE="$PWD/release/unpacked/package/live-delivery" node test/provider-env-native.mjs
   QWEN_LD_TEST_PACKAGE="$PWD/release/unpacked/package/live-delivery" npm run test:codex
   QWEN_LD_TEST_PACKAGE="$PWD/release/unpacked/package/live-delivery" QWEN_LD_TEST_FEEDBACK=1 npm run test:codex
   ```

   每个候选包使用新的输出目录，打包脚本不会覆盖已有文件。检查压缩包和截图是否包含凭证、私有链接、工作区、日志或无权分发的素材，自动检查不能代替人工审查。

为测试通过的提交创建标签，例如 `qwen-live-delivery-codex-v0.1.0`，在 GitHub Release 附上压缩包与 `SHA256SUMS`，说明支持的平台、已测试的 Codex 版本和已知限制。已发布标签和压缩包保持不变，修复使用新版本号。

首版无需更新记录。后续发布说明用户可见变化和迁移步骤。发布前确认 [SECURITY.md](../SECURITY.md) 中的私密报告渠道可用。
