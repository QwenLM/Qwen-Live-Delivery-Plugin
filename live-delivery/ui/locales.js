/* UI translations only. Original artifacts, files, task content and user drafts stay unchanged. */
(() => {
  const en = {
    '任务状态已更新，请重新打开预算设置。':
      'The task has changed. Please reopen the budget settings.',
    '请求超时，尚未确认结果；请稍后重试。':
      'Request timed out; the result is unconfirmed. Please retry shortly.',
    交付版本: 'Delivery versions',
    待交付目标: 'Planned delivery',
    下一版: 'Next version',
    正在接收新要求: 'Receiving your new instructions',
    已中断: 'Interrupted',
    本版改动: 'Changes in this version',
    未记录改动说明: 'No change summary recorded',
    '开始后 {duration} 交付': 'Delivered {duration} after start',
    对话记录: 'Conversation history',
    'Agent 正在输出': 'Agent is writing',
    'Enter 发送 · Shift+Enter 换行': 'Enter to send · Shift+Enter for a new line',
    'V{id} 已交付': 'V{id} delivered',
    '{count} 个可用版本': '{count} available versions',
    '{days} 天 {hours} 小时': '{days}d {hours}h',
    '{hours} 小时 {minutes} 分': '{hours}h {minutes}m',
    '{minutes} 分 {seconds} 秒': '{minutes}m {seconds}s',
    '下一版想怎么调整？': 'What should change in the next version?',
    继续执行预算: 'Time budget to continue',
    本次预算: 'Current execution budget',
    '本次预算 {duration}': 'Current budget · {duration}',
    '继续执行预算 {duration}': 'Continue for {duration}',
    下载: 'Download',
    不再提示: "Don't show again",
    交付与预览: 'Deliveries & preview',
    交付成果预览: 'Delivered artifact preview',
    交付详情: 'Delivery details',
    '任务正在推进，可以在左侧继续补充要求。':
      'Work is in progress. Add instructions in the conversation anytime.',
    任务需求: 'Task request',
    任务需求或补充要求: 'Task or follow-up instructions',
    使用指引: 'Quick guide',
    保存: 'Save',
    停止任务: 'Stop task',
    '停止请求已发送，当前操作结束后收尾。已有版本会保留。':
      'Stop requested. The Agent will wrap up after the current operation. Delivered versions are kept.',
    '先交付，再不断完善。': 'Deliver early. Keep improving.',
    关闭: 'Close',
    分钟: 'min',
    切换任务: 'Switch task',
    历史记录: 'History',
    发送: 'Send',
    '在 Codex 输入 $ld:go 和你的需求，这里会显示交付成果。':
      'Enter $ld:go and your request in Codex. Deliveries will appear here.',
    '在 Claude Code 输入 /ld:go 和你的需求，这里会显示交付成果。':
      'Enter /ld:go and your request in Claude Code. Deliveries will appear here.',
    在这里描述需求: 'Describe your task here',
    天: 'days',
    实际: 'Actual',
    实际用时: 'Delivered after',
    '实际用时 {duration}': 'Delivered after {duration}',
    宿主验证: 'Host-verified',
    对话: 'Conversation',
    小时: 'hours',
    工作区: 'Workspace',
    已交付: 'Delivered',
    已停止: 'Stopped',
    已完成: 'Completed',
    已延期: 'Delayed',
    '已延期 {duration}': 'Overdue by {duration}',
    '已有 {count} 个可用版本 · 已用 {duration}': '{count} usable versions · {duration} elapsed',
    '已有记录已保留，可以继续对话。':
      'Your records are saved. Continue the conversation when ready.',
    '已用 {duration}': 'Elapsed {duration}',
    已读: 'Read',
    开始: 'Start',
    开始一次持续交付: 'Start Live Delivery',
    总预算: 'Time budget',
    '总预算 {duration}': 'Budget · {duration}',
    总预算已保存: 'Time budget saved',
    '总预算已保存。': 'Time budget saved.',
    总预算数值: 'Time budget value',
    成果预览: 'Artifact preview',
    执行中: 'Running',
    执行失败: 'Execution failed',
    执行详情: 'Execution details',
    持续交付: 'Live Delivery',
    按文件名搜索: 'Search by file name',
    掌握总投入: 'Control your time budget',
    '接下来还想怎么改进？': 'What would you like to improve next?',
    '描述你想完成的成果…': 'Describe what you want to create…',
    '描述你想完成的成果，Agent 会先交付可用首版，再逐版改进。':
      'Describe the result you want. The Agent will deliver a usable first version and keep improving it.',
    描述需求: 'Describe your task',
    '描述需求后开始。每次交付都可以预览、下载。':
      'Describe your task to start. Preview and download every delivery.',
    '操作失败，未确认生效。': 'Action failed; no change was confirmed.',
    放大预览: 'Expand preview',
    文件: 'Files',
    新任务: 'New task',
    新工作区: 'New workspace',
    新工作区名称: 'New workspace name',
    新建任务: 'New task',
    最新: 'Latest',
    未收到完成记录: 'No completion received',
    未读: 'Unread',
    未通过: 'Failed',
    未验证: 'Not checked',
    尚无交付: 'No delivery yet',
    尚未交付: 'Not delivered yet',
    查看每版成果: 'See every delivery',
    模型自检: 'Agent-reported',
    正在停止: 'Stopping',
    正在准备: 'Preparing',
    正在制作首版: 'Building the first version',
    正在发送: 'Sending',
    '正在执行：{tool}': 'Running: {tool}',
    正在推进: 'Running',
    正在规划下一版: 'Planning the next version',
    '正在评估成果，规划下一版': 'Evaluating the result and planning the next version',
    正在输出: 'Writing',
    正在运行: 'Running',
    正在连接: 'Connecting',
    此文件请独立打开或下载: 'Open this file separately or download it',
    '点击版本预览成果。已交付版本会保留，随时可以下载。':
      'Select a version to preview it. Delivered versions are kept and can be downloaded anytime.',
    版本预览: 'Version preview',
    独立打开: 'Open separately',
    '从继续执行时开始计时，已有对话和版本保留。':
      'Time starts when execution resumes. Your conversation and versions stay in this task.',
    '直接开始制作。想调整下一版的内容或时间，继续在这里说。':
      'Production starts directly. Use this conversation to adjust the next version or its timing.',
    知道了: 'Got it',
    等待任务: 'Waiting for a task',
    等待连接恢复: 'Waiting to reconnect',
    继续执行: 'Continue execution',
    '让成果先到手，再不断完善。': 'Get a usable result. Keep making it better.',
    '请填写新工作区名称。': 'Enter a new workspace name.',
    调用失败: 'Call failed',
    调用结束: 'Call finished',
    跳过指引: 'Skip tour',
    '达到总预算后收尾，保留最近可用版本。':
      'Wrap up at the time limit and keep the latest usable version.',
    运行中: 'Running',
    '这里设置总预算。需要结束时，点击旁边的停止任务。':
      'Set the total time here. Use Stop task when you want to finish.',
    连接中断: 'Disconnected',
    '连接中断不代表执行已停止；当前显示最后收到的记录。':
      'A lost connection does not mean execution has stopped. Showing the last received record.',
    '连接中断，操作未发送。': 'Disconnected. The action was not sent.',
    退出放大预览: 'Exit expanded preview',
    选择工作区: 'Choose a workspace',
    通过: 'Passed',
    重新打开本版预览入口: 'Reopen this version’s preview entry',
    '页面更新出错，草稿已保留，请刷新重试。':
      'The page could not update. Your draft is saved. Refresh to retry.',
    '预算 {duration}': 'Budget {duration}',
    预算时间单位: 'Budget time unit',
    预览首页: 'Preview home',
    预计: 'Estimate',
    '预计还需 {duration}': 'Estimated remaining: {duration}',
    '首版可用，逐版改进。': 'A usable first version. Better with each delivery.',
    '＋ 新工作区': '＋ New workspace',
    '＋ 新建任务': '+ New task',
  };
  const storageKey = 'live-delivery-ui-language';
  let lang = 'zh';
  try {
    if (localStorage.getItem(storageKey) === 'en') lang = 'en';
  } catch (_) {}
  const missing = new Set();
  function t(source, values = {}) {
    if (lang === 'en' && /[\u3400-\u9fff]/.test(source) && !Object.hasOwn(en, source))
      missing.add(source);
    const template = lang === 'en' ? (en[source] ?? source) : source;
    return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
  }
  // Capture authored static text once, retaining icons, focus and form values.
  // Dynamic UI messages use t() explicitly; arbitrary user text is never translated.
  const bindings = [];
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('script,style,.language-switch')) continue;
    const raw = node.nodeValue,
      source = raw.trim().replace(/\s+/g, ' ');
    if (/[\u3400-\u9fff]/.test(source)) bindings.push({ node, raw, source });
  }
  const attributes = [];
  document.querySelectorAll('*').forEach((element) => {
    if (element.closest('.language-switch')) return;
    for (const name of ['aria-label', 'placeholder', 'title']) {
      const source = element.getAttribute(name);
      if (source && /[\u3400-\u9fff]/.test(source)) attributes.push({ element, name, source });
    }
  });
  function apply() {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    bindings.forEach(
      ({ node, raw, source }) => (node.nodeValue = raw.replace(raw.trim(), () => t(source))),
    );
    attributes.forEach(({ element, name, source }) => element.setAttribute(name, t(source)));
    document
      .querySelectorAll('[data-lang]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.lang === lang)),
      );
  }
  window.QWEN_LD_I18N = {
    t,
    apply,
    missing,
    get lang() {
      return lang;
    },
    setLanguage(value) {
      lang = value === 'en' ? 'en' : 'zh';
      try {
        localStorage.setItem(storageKey, lang);
      } catch (_) {}
      apply();
    },
  };
})();
