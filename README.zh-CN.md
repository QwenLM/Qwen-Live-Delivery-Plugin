[![Qwen Live Delivery Plugin — 边做边交付，方向全掌控。Ship as you go. Steer as it grows. 迈向 Live Agent 的第一步。](docs/assets/header.png)](docs/assets/header.png)

[English](README.md) · **中文**

**首发适配：Codex CLI** · **支持系统：Linux · macOS** · Node.js 22+

让 Agent 长时间工作、持续交付，并随时接受你的纠偏。

## 概览

随着长程/长时（Long-horizon）AI Agents 逐渐成为行业主流，我们却面临着一个无比真实的痛点：你是否曾因为把一个长耗时任务完全丢给 Agent 而战战兢兢，生怕它在“黑盒”中一路狂奔，最终给你交付一份偏离预期、难以补救的成果？为了打破这种失控感，我们推出了 Qwen-Live-Delivery-Plugin。这是一款专为长时任务设计的轻量级插件，它不仅能让 Agent 保持长时间稳定工作与持续交付，还能让用户（Human-in-the-loop）随时补充要求、调整方向。插件由三大核心模块构成：

1. **Live Delivery Skill**（[`$ld:go`](live-delivery/skills/go/SKILL.md)）：指导 Agent 选择最小可用首版，再根据实际成果规划下一版，把验证与交付纳入每轮工作，不预设总版数。
2. **Live Delivery MCP**：通过 `ld_begin`、`ld_publish`、`ld_status`、`ld_done` 管理交付计划和状态，保存完整版本快照与预览入口，并提供预算查询和任务收尾工具。
3. **Lifecycle Hooks**：在会话恢复或工具调用结束时传入用户反馈；任务尚未结束且预算仍有余量时阻止过早结束回合，收到停止请求或预算耗尽时配合收尾。

本地网页工作台把这些能力集中到一个界面：查看进展、预览和下载各版本、追加要求，以及调整总预算或停止任务。网页创建的任务由工作台启动；追加消息时，工作台中断并续接同一 Codex 会话，再由 Hooks 传入反馈。外部 CLI 任务在支持的工具或回合事件中接收反馈。

## 演示

示例展示了 Agent 如何通过持续交付，从零搭建 ORBIT 个人交易研究网站：先交出可用首版，再逐步完善行情看板、策略回测和模拟交易功能。持续交付过程中，用户亦可以随时试用，随时补充要求，Agent 接受反馈后则继续开发，并将改进交付到后续版本中。

![持续交付演示](docs/assets/orbit-live-delivery-zh.gif)

## 工作原理

[![用 ld:go 启动持续交付：交任务，Agent 持续工作，看成果并提要求。用户可随时补充要求，Hooks 将反馈带回 Agent，调整下一版；停止或预算用尽时保留成果。](docs/assets/lifecycle.png)](docs/assets/lifecycle.png)

启动一次，先交付可用首版，再逐版改进。你可以随时补充要求、调整方向；停止任务或预算用尽时保留已交付成果。

在滚动交付中，同一验收项的结果相互矛盾时会拒绝发布。重新检查后提交最终结果即可，被拒绝的尝试不占用版本号。

## 安装

安装沿用你的 Codex 模型、认证和审批设置，不附带模型或 API key。 网页新任务默认使用 `workspace-write` 沙箱；显式设置 `QWEN_LD_TASK_SANDBOX=danger-full-access` 会关闭其执行沙箱和逐条命令审批，可访问当前系统账号有权限访问的工作区外文件。安装器不会自动启用全权限。

### 让 Agent 安装

把仓库目录交给 Codex，直接说：

```text
请阅读 /绝对路径/Qwen-Live-Delivery-Plugin/README.zh-CN.md，按照安装 skill 安装并验证插件。工作区使用 /绝对路径/我的项目。
```

安装助手应读取本包的 [安装 skill](live-delivery/skills/install/SKILL.md)。安装后也可用 `$ld:install` 检查或修复安装。

### 手动安装

进入仓库目录并运行：

```bash
cd /path/to/Qwen-Live-Delivery-Plugin
./live-delivery/install.sh --workspace /path/to/project
```

按 Enter 完成安装和 hook 配置，随后打开 Codex。发行包无需运行 `npm install`；已有 Codex 会话需要重新打开。

只安装、不启动 Codex 可加 `--install-only`；检查安装状态用 `./live-delivery/install.sh --doctor`。

<details>
<summary>更新与卸载</summary>

更新前先结束运行中的任务，再从新版本目录运行 `./live-delivery/install.sh --install-only`，随后重开 Codex。卸载命令如下，不会删除工作区和交付记录：

```bash
codex plugin remove ld@live-delivery-local --json
codex plugin marketplace remove live-delivery-local --json
```

</details>

## 快速开始

在项目目录启动 Codex：

```bash
cd /path/to/project
QWEN_LD_TIME_BUDGET=12m codex
```

输入需求：

```text
$ld:go 制作一个离线可用的单摆实验网页，可以调节摆长、暂停动画，并解释周期和摆长的关系。手机上也要好用。
```

**启动任务后，请打开 CLI 给出的工作台链接，在网页查看计划、预览成果和继续对话。** 链接包含工作台访问凭证，请勿公开分享；重启后使用最新链接。桌面环境会尝试自动打开浏览器；远程服务器请使用输出中的服务器地址。

1. 首版交付后，点击右侧版本查看成果；展开**文件**可切换预览或下载单个文件。
2. 在左侧追加要求，**Enter 发送，Shift+Enter 换行**。
3. 顶部的**总预算**控制投入，需要结束时点击**停止任务**。

任务完成后继续对话，仍保留在同一任务中，之前的对话和各版本预览都可查看。只有点击**新任务**才会另开记录。

顶部的**使用指引**提供箭头提示，可随时关闭或重新打开。总预算支持分钟、小时和天，最长 7 天；交付时间是预估，停止任务需要等待当前工具结束。

工作台请在可信网络使用；仅本机或 SSH 转发访问时，启动前设置 `QWEN_LD_BIND_HOST=127.0.0.1`。

当前插件 **0.1.0**，已使用 Codex **0.166.0 / 0.167.1** 验证。

## 文档

- [贡献指南（英文）](CONTRIBUTING.md) · [开发与测试](docs/development.zh-CN.md)
- [安全说明（英文）](SECURITY.md)

## 开发计划

- [ ] **支持更多 Agent Harness**：复用现有 MCP 交付工具和版本快照，适配不同 Harness 的安装方式、生命周期 Hook、会话管理以及中断与恢复接口。补齐版本发布、执行中追加要求、任务续聊和停止操作的端到端兼容性测试。

## 引用

如果我们的插件对你有帮助，欢迎引用：

```bibtex
@inproceedings{qwen_live_delivery_plugin_2026,
  title={Qwen-Live-Delivery-Plugin: Ship as you go. Steer as it grows.},
  author={{Qwen Team}},
  year={2026},
  url={https://github.com/QwenLM/Qwen-Live-Delivery-Plugin}
}
```

## 许可证

插件采用 [Apache-2.0](LICENSE) 许可证。
