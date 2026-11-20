# Claude Code

[English](claude-code.md) · **中文** · [README](../README.zh-CN.md)

Live Delivery 也可以作为 Claude Code 插件运行。Claude Code 会话与 Codex 使用相同的技能、相同的四个 MCP 工具（`ld_begin`、`ld_publish`、`ld_status`、`ld_done`）、相同的版本快照和同一个浏览器工作台。任务记录格式一致，两个 Agent 环境可以在同一个项目中使用。

目前 Claude Code 支持**从 Claude Code 命令行启动的任务**。从浏览器工作台新建任务暂时仅支持 Codex（见[限制](#限制)）。

## 环境要求

- Linux 或 macOS（Windows 请使用 WSL），`PATH` 中有 Node.js 22+
- 支持插件的 Claude Code，并已使用你自己的账号或 API Key 登录；插件不包含任何模型或凭据

## 安装

在终端中运行：

```bash
claude plugin marketplace add QwenLM/Qwen-Live-Delivery-Plugin
claude plugin install ld@qwen-live-delivery
```

或在 Claude Code 会话中输入：

```text
/plugin marketplace add QwenLM/Qwen-Live-Delivery-Plugin
/plugin install ld@qwen-live-delivery
```

插件从 `live-delivery/claude-code/` 读取，其中已包含构建好的运行时，无需 `npm install`。安装后请开启新会话。`claude mcp list` 应显示 `plugin:ld:live-delivery` 已连接。

如需从本地仓库安装，运行 `claude plugin marketplace add /path/to/Qwen-Live-Delivery-Plugin`。

更新时运行 `claude plugin marketplace update qwen-live-delivery` 并开启新会话。卸载（保留工作区和交付记录）：

```bash
claude plugin uninstall ld@qwen-live-delivery
claude plugin marketplace remove qwen-live-delivery
```

## 快速开始

```bash
cd /path/to/project
QWEN_LD_TIME_BUDGET=12m claude
```

然后使用 `/ld:go` 命令输入需求：

```text
/ld:go 做一个离线单摆实验。可以调整摆长、暂停动画，并理解摆长如何影响周期。
```

打开会话中显示的工作台链接，查看计划、预览版本并发送反馈。该链接授予工作台访问权限，请勿公开。从工作台发送的反馈会在 Claude 下一次调用工具后、或尝试结束本轮时送达。

任务进行中且仍有预算时，插件的 `Stop` Hook 会让 Claude 继续推进下一个里程碑。可以在工作台中使用**停止任务**，或通过顶部的**时间预算**提前结束。

## 配置

与 Codex 插件使用相同的 `QWEN_LD_*` 环境变量，在启动 `claude` 的终端中设置，例如 `QWEN_LD_TIME_BUDGET`、`QWEN_LD_BIND_HOST=127.0.0.1` 和 `QWEN_LD_OPEN_BROWSER=never`。Claude Code 工作台默认使用 18790 端口（Codex 使用 18791），两者可以同时运行。私有状态保存在 `~/.claude/live-delivery/`（或 `$CLAUDE_CONFIG_DIR`）下。

## 限制

- **暂不支持从浏览器新建任务。** Claude Code 工作台会隐藏**新建任务**，并拒绝从浏览器创建任务。请在 Claude Code 中用 `/ld:go` 启动每个任务。浏览器新建任务计划在后续版本中支持。
- **没有中断事件。** Claude Code 没有对应 Codex `Interrupt` 的 Hook。按 Esc 中断后，任务仍保持进行中，Claude 会在你发送下一条消息时继续。请使用**停止任务**结束任务；结束会话（`SessionEnd`）会像 Codex 一样暂停任务。
- **没有安装器和诊断。** `install.sh` 和 `$ld:install` 仅适用于 Codex。请使用上面的 `claude plugin` 命令。
