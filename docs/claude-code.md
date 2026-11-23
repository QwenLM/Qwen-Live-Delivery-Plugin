# Claude Code

**English** · [中文](claude-code.zh-CN.md) · [README](../README.md)

Live Delivery also runs as a Claude Code plugin. Claude Code sessions use the same skill, the same four MCP tools (`ld_begin`, `ld_publish`, `ld_status`, `ld_done`), the same version snapshots and the same browser dashboard as Codex and Qwen Code. Task records use the same format, so both harnesses can work in one project.

Claude Code support currently covers **tasks started from the Claude Code CLI**. Starting new tasks from the browser workbench is still Codex-only (see [Limitations](#limitations)).

## Requirements

- Linux or macOS (on Windows, use WSL), Node.js 22+ on `PATH`
- Claude Code with plugin support, signed in with your own account or API key; the plugin includes no model or credentials

## Install

From a shell:

```bash
claude plugin marketplace add QwenLM/Qwen-Live-Delivery-Plugin
claude plugin install ld@qwen-live-delivery
```

Or inside a Claude Code session:

```text
/plugin marketplace add QwenLM/Qwen-Live-Delivery-Plugin
/plugin install ld@qwen-live-delivery
```

The plugin is read from `live-delivery/claude-code/`, which contains the prebuilt runtime; no `npm install` is needed. Start a new session after installing. `claude mcp list` should show `plugin:ld:live-delivery` as connected.

To install from a local checkout instead, run `claude plugin marketplace add /path/to/Qwen-Live-Delivery-Plugin`.

To update, run `claude plugin marketplace update qwen-live-delivery` and start a new session. To uninstall (workspaces and delivery records are kept):

```bash
claude plugin uninstall ld@qwen-live-delivery
claude plugin marketplace remove qwen-live-delivery
```

## Quick start

```bash
cd /path/to/project
QWEN_LD_TIME_BUDGET=12m claude
```

Then enter your request with the `/ld:go` command:

```text
/ld:go Build an offline pendulum experiment. Let me adjust the length, pause the animation, and understand how length affects the period.
```

Open the workbench link that appears in the session to view the plan, preview versions and send feedback. The link grants workbench access; keep it private. Feedback sent from the workbench reaches Claude after its next tool call, or when it tries to end its turn.

While the task is active and budget remains, the plugin's `Stop` hook asks Claude to keep working on the next milestone. Use **Stop task** in the workbench or **Time budget** in the header to finish earlier.

## Configuration

Use the same `QWEN_LD_*` variables as the Codex plugin, set in the shell that starts `claude`, for example `QWEN_LD_TIME_BUDGET` and `QWEN_LD_OPEN_BROWSER=never`. As with Qwen Code, each Claude Code session serves its own dashboard on `127.0.0.1` only, on a free port unless `QWEN_LD_PORT` is set, so it can run alongside Codex. Delivery records stay in the project's `.live-delivery/` directory.

## Limitations

- **No browser-created tasks yet.** The Claude Code dashboard shows the current session's task and has no **New task** button. Start each task in Claude Code with `/ld:go`. Browser-created tasks are planned as a follow-up.
- **No interrupt event.** Claude Code has no hook for an interrupted turn (Codex's `Interrupt`). If you press Esc, the task stays active and Claude continues it on your next prompt. Use **Stop task** to end it; ending the session (`SessionEnd`) pauses it, as in Codex.
- **No installer or doctor.** `install.sh` and `$ld:install` are Codex-only. Use the `claude plugin` commands above.
