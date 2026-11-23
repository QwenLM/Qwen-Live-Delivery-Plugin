(() => {
  'use strict';
  const $ = (id) => document.getElementById(id),
    i18n = window.QWEN_LD_I18N,
    t = i18n.t;
  if (new URLSearchParams(location.hash.slice(1)).has('access'))
    history.replaceState(null, '', location.pathname + location.search);
  const base = location.pathname.replace(/\/$/, '');
  const params = new URLSearchParams(location.search);
  let runId = params.get('run'),
    sessionId = params.get('s'),
    data = null,
    connected = false;
  let composing = false,
    initialized = false,
    generation = 0,
    polling = false,
    busy = false;
  let selected = null,
    followLatest = true,
    fileOverride = null,
    draftId = null,
    budgetDraft = null;
  let observedAt = 0,
    feedSignature = '',
    versionsSignature = '',
    toastTimer,
    newWorkspaceId = null;
  let guideIndex = -1,
    guideTarget = null,
    budgetContext = null;
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const uid = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('');
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const key = () =>
    composing ? `${base}:new-task` : `${base}:draft:${runId ?? sessionId ?? 'cli'}`;
  const release = () => data?.releases?.find((r) => r.version === selected);
  const pending = () =>
    data?.plan?.filter((m) => !data.releases.some((r) => r.version === m.version)) ?? [];
  const planTime = (m) => m.estimatedTs ?? m.targetTs;
  function duration(seconds) {
    const n = Math.max(0, Math.round(seconds));
    if (n >= 86400)
      return t('{days} 天 {hours} 小时', {
        days: Math.floor(n / 86400),
        hours: Math.floor(n / 3600) % 24,
      });
    if (n >= 3600)
      return t('{hours} 小时 {minutes} 分', {
        hours: Math.floor(n / 3600),
        minutes: Math.floor(n / 60) % 60,
      });
    return t('{minutes} 分 {seconds} 秒', { minutes: Math.floor(n / 60), seconds: n % 60 });
  }
  const relative = (ts) => {
    const segment = [...(data.timeline ?? [])].reverse().find((item) => item.startedTs <= ts);
    return duration(
      (segment?.elapsedBeforeSec ?? 0) + (ts - (segment?.startedTs ?? data.task.startedTs)) / 1000,
    );
  };
  function persist() {
    try {
      localStorage.setItem(
        key(),
        JSON.stringify({
          text: $('feedback').value,
          draftId,
          selected,
          followLatest,
          fileOverride,
          budgetDraft,
          workspace: $('task-workspace').value,
          workspaceName: $('workspace-name').value,
        }),
      );
    } catch (_) {}
  }
  function restore() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(key()) ?? '{}');
    } catch (_) {}
    $('feedback').value = stored.text || '';
    draftId = stored.draftId || null;
    selected = Number(stored.selected) || null;
    followLatest = stored.followLatest !== false;
    fileOverride = stored.fileOverride || null;
    budgetDraft =
      Number.isInteger(stored.budgetDraft?.seconds) &&
      stored.budgetDraft.seconds >= 60 &&
      stored.budgetDraft.seconds <= 604800
        ? stored.budgetDraft
        : null;
    renderWorkspaceChoices();
    if (
      stored.workspace &&
      [...$('task-workspace').options].some((o) => o.value === stored.workspace)
    )
      $('task-workspace').value = stored.workspace;
    $('workspace-name').value = stored.workspaceName || '';
    $('workspace-name').hidden = $('task-workspace').value !== 'new';
  }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').hidden = true), 6000);
  }
  function execution() {
    if (!connected) return { kind: 'disconnected', label: '连接中断' };
    if (composing) return { kind: 'new', label: '新任务' };
    const task = data?.task,
      host = data?.workbench?.execution;
    if (host?.status === 'failed') return { kind: 'failed', label: '执行失败' };
    if (!task)
      return {
        kind: host?.status === 'starting' ? 'planning' : 'idle',
        label: host?.status === 'starting' ? '正在准备' : '等待任务',
      };
    if (task.stopRequest && !task.stopRequest.confirmedTs)
      return { kind: 'stopping', label: '正在停止' };
    if (task.acceptingFeedback) return { kind: 'running', label: '正在接收新要求' };
    if (task.status === 'paused' || task.stopRequest?.confirmedTs)
      return { kind: 'stopped', label: '已停止' };
    if (task.status === 'done') return { kind: 'done', label: '已完成' };
    if (host?.status === 'finished') return { kind: 'stopped', label: '已停止' };
    if (data.capabilities.readOnly) return { kind: 'history', label: '历史记录' };
    return {
      kind: !data.plan.length || task.awaitingNextPlan ? 'planning' : 'running',
      label: !data.plan.length || task.awaitingNextPlan ? '正在规划下一版' : '正在运行',
    };
  }
  const continuing = () =>
    !composing &&
    connected &&
    !!data?.workbench?.canCreateTask &&
    ['done', 'paused'].includes(data?.task?.status) &&
    !data.workbench.workspaces.find((w) => w.id === data.workbench.workspace.id)?.busy;
  const active = () => !composing && ['running', 'planning'].includes(execution().kind);
  function budgetSeconds() {
    if (composing || continuing())
      return (
        budgetDraft?.seconds ??
        QWEN_LD_BUDGET.requestedBudget($('feedback').value) ??
        data?.task?.timeBudgetSec ??
        1800
      );
    return data?.task?.timeBudgetSec ?? 1800;
  }
  async function post(action, values, manager = false) {
    if (!connected) throw new Error(t('连接中断，操作未发送。'));
    const prefix = manager ? base : (data?.controlBase ?? base);
    const response = await fetch(`${prefix}/api/${action}`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-CD-Token': data.csrfToken },
      body: JSON.stringify(manager ? values : { session_id: sessionId, ...values }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || t('操作失败，未确认生效。'));
    return result;
  }
  async function poll() {
    if (polling) return;
    polling = true;
    const current = generation;
    try {
      const response = await fetch(
        `${base}/api/state${runId ? `?run=${encodeURIComponent(runId)}` : sessionId ? `?s=${encodeURIComponent(sessionId)}` : ''}`,
        { cache: 'no-store', signal: AbortSignal.timeout(8000) },
      );
      if (!response.ok) throw new Error('State unavailable');
      const next = await response.json();
      if (next.apiVersion !== 1) throw new Error('Unsupported state');
      if (current !== generation) return;
      const changed = next.workbench?.selectedRun
        ? next.workbench.selectedRun !== runId
        : next.task?.id !== sessionId;
      data = next;
      connected = true;
      observedAt = performance.now();
      runId = data.workbench?.selectedRun ?? runId;
      sessionId = data.task?.id ?? null;
      if (!initialized) {
        composing = !data.task && !!data.workbench?.canCreateTask;
        initialized = true;
        restore();
      } else if (changed && !composing) restore();
      if (!composing && sessionId)
        history.replaceState(
          null,
          '',
          `${base}/?${runId ? `run=${encodeURIComponent(runId)}` : `s=${encodeURIComponent(sessionId)}`}`,
        );
      if (followLatest || !data.releases?.some((r) => r.version === selected))
        selected = data.releases?.at(-1)?.version ?? null;
      safeRender();
      maybeShowGuide();
    } catch (_) {
      if (current === generation) {
        connected = false;
        safeRender();
      }
    } finally {
      polling = false;
      if (current !== generation) void poll();
    }
  }
  function safeRender() {
    try {
      render();
    } catch (error) {
      console.error('Workbench render failed', error);
      $('state-notice').textContent = t('页面更新出错，草稿已保留，请刷新重试。');
      $('state-notice').hidden = false;
    }
  }
  function renderWorkspaceChoices() {
    const select = $('task-workspace'),
      previous = select.value;
    const signature = JSON.stringify([data?.workbench?.workspaces, i18n.lang]);
    if (select.dataset.signature === signature) return;
    select.dataset.signature = signature;
    select.innerHTML =
      (data?.workbench?.workspaces ?? [])
        .map(
          (w) =>
            `<option value="${esc(w.id)}" ${w.busy ? 'disabled' : ''}>${esc(w.name)}${w.busy ? ` · ${t('运行中')}` : ''}</option>`,
        )
        .join('') + `<option value="new">${t('＋ 新工作区')}</option>`;
    select.value = [...select.options].some((o) => o.value === previous && !o.disabled)
      ? previous
      : 'new';
    $('workspace-name').hidden = select.value !== 'new';
  }
  function renderFeed() {
    const messages = composing ? [] : (data?.messages ?? []);
    const outputs = composing
      ? []
      : (data?.agentOutput ?? []).filter(
          (o) => !messages.some((m) => m.role === 'agent' && m.text.trim() === o.text.trim()),
        );
    const signature = JSON.stringify([composing, messages, outputs, data?.feedback, i18n.lang]);
    if (signature === feedSignature) return;
    feedSignature = signature;
    const feed = $('feed'),
      bottom = feed.scrollHeight - feed.clientHeight - feed.scrollTop < 65,
      oldScroll = feed.scrollTop;
    if (composing || !data?.task) {
      feed.innerHTML = `<div class="welcome"><strong>${t('先交付，再不断完善。')}</strong><p>${t(data?.workbench?.canCreateTask ? '描述你想完成的成果，Agent 会先交付可用首版，再逐版改进。' : data?.harness === 'claude-code' ? '在 Claude Code 输入 /ld:go 和你的需求，这里会显示交付成果。' : '在 Codex 输入 $ld:go 和你的需求，这里会显示交付成果。')}</p></div>`;
      return;
    }
    const entries = [
      ...messages.map((m) => ({ ...m, source: 'message' })),
      ...outputs.map((m) => ({ ...m, role: 'agent', source: 'output' })),
    ].sort(
      (a, b) =>
        (a.beforeTs ?? a.ts) - (b.beforeTs ?? b.ts) ||
        Number(a.beforeTs === undefined) - Number(b.beforeTs === undefined) ||
        (a.order ?? 0) - (b.order ?? 0),
    );
    feed.innerHTML = entries
      .map((m) => {
        if (m.role === 'event') {
          if (m.kind === 'published')
            return `<button class="delivery-event" data-version="${m.version}">${icon('check')}<span>${t('V{id} 已交付', { id: m.version })}</span><time>${relative(m.ts)}</time></button>`;
          return '';
        }
        const receipt = data.feedback?.find((f) => f.id === m.id);
        return `<article class="message ${m.role === 'user' ? 'user' : 'agent'}" ${m.source === 'output' ? `data-output-id="${esc(m.id)}"` : ''}><div class="message-label">${m.role === 'user' ? '' : `${m.status === 'streaming' && active() ? '<span class="live-dot"></span>' : ''}Agent`}</div><p>${esc(m.text)}</p>${receipt ? `<span class="receipt">${t(receipt.status === 'queued' ? '未读' : '已读')}</span>` : ''}</article>`;
      })
      .join('');
    feed
      .querySelectorAll('[data-version]')
      .forEach((b) => (b.onclick = () => selectVersion(Number(b.dataset.version))));
    feed.scrollTop = bottom ? feed.scrollHeight : oldScroll;
  }
  function renderActivity() {
    const events = composing ? [] : (data?.executionEvents ?? []),
      running = active(),
      tool = events.filter((e) => e.status === 'running').at(-1),
      streaming = data?.agentOutput?.some((m) => m.status === 'streaming');
    $('current-activity').hidden = !running;
    $('activity-text').textContent = data?.task?.acceptingFeedback
      ? t('正在接收新要求')
      : tool
        ? t('正在执行：{tool}', { tool: tool.detail || tool.tool })
        : streaming
          ? t('Agent 正在输出')
          : data?.task?.activity?.text || t(execution().label);
    $('execution-details').hidden = !events.length;
    $('tool-count').textContent = String(events.length);
    const list = $('execution-entries'),
      signature = JSON.stringify([events, running, i18n.lang]);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    const bottom = list.scrollHeight - list.clientHeight - list.scrollTop < 32,
      scroll = list.scrollTop;
    list.innerHTML = events
      .map(
        (e) =>
          `<article class="tool" data-status="${esc(e.status)}">${e.status === 'running' && running ? '<span class="live-dot"></span>' : ''}<code>${esc([e.detail || e.tool, ...(e.files ?? [])].filter(Boolean).join(' · '))}</code><small>${t(e.status === 'interrupted' ? '已中断' : e.status === 'failed' ? '调用失败' : e.status === 'running' && running ? '执行中' : e.status === 'running' ? '未收到完成记录' : '调用结束')} · ${relative(e.ts)}</small></article>`,
      )
      .join('');
    list.scrollTop = bottom ? list.scrollHeight : scroll;
  }
  function renderVersions() {
    const releases = composing ? [] : (data?.releases ?? []);
    const upcoming = composing ? [] : pending();
    const planned = upcoming.length ? upcoming : active() ? [null] : [];
    const cards = releases.map((r) => ({
      ...r,
      title: r.title ?? t('已交付'),
    }));
    const signature = JSON.stringify([
      cards.map((r) => [r.version, r.ts, r.title, r.note]),
      planned,
      selected,
      active(),
      connected,
      i18n.lang,
    ]);
    const list = $('versions');
    if (signature !== versionsSignature) {
      versionsSignature = signature;
      const scroll = list.scrollLeft;
      list.innerHTML =
        cards
          .map(
            (r, i) =>
              `<button class="version" data-version="${r.version}" aria-pressed="${r.version === selected}"><span class="version-heading"><b>V${r.version}</b>${i === releases.length - 1 ? `<span class="latest">${t('最新')}</span>` : ''}</span><strong class="version-title">${esc(r.title)}</strong><span class="version-note">${esc(r.note || t('未记录改动说明'))}</span><small>${t('开始后 {duration} 交付', { duration: relative(r.ts) })}</small></button>`,
          )
          .join('') +
        planned
          .map(
            (m, i) =>
              `<article class="version version-planned" ${i === 0 ? 'id="next-version"' : ''} title="${esc(m?.scope ?? '')}"><span class="version-heading"><b>V${m?.version ?? data?.task?.nextVersion ?? 1}</b><span class="planned-status">${active() ? `<span class="spinner" ${i === 0 ? 'id="next-spinner"' : ''} aria-hidden="true"></span>` : ''}<span ${i === 0 ? 'id="next-label"' : ''}>${t(m ? '待交付目标' : '下一版')}</span></span></span><strong class="version-title" ${i === 0 ? 'id="next-title"' : ''}>${esc(m?.title ?? t('正在评估成果，规划下一版'))}</strong><span class="version-note" ${i === 0 ? 'id="next-scope"' : ''}>${esc(m?.scope ?? '')}</span><small data-planned-index="${i}" ${i === 0 ? 'id="next-time"' : ''}></small></article>`,
          )
          .join('');
      list
        .querySelectorAll('[data-version]')
        .forEach(
          (button) => (button.onclick = () => selectVersion(Number(button.dataset.version))),
        );
      list.scrollLeft = scroll;
      const focusKey =
        followLatest && planned.length ? `next-${upcoming[0]?.id ?? 'planning'}` : String(selected);
      const current =
        followLatest && planned.length
          ? $('next-version')
          : list.querySelector('[aria-pressed="true"]');
      if (current && list.dataset.focusKey !== focusKey) {
        const rect = current.getBoundingClientRect(),
          bounds = list.getBoundingClientRect();
        if (rect.left < bounds.left) list.scrollLeft += rect.left - bounds.left;
        else if (rect.right > bounds.right) list.scrollLeft += rect.right - bounds.right;
      }
      list.dataset.focusKey = focusKey;
    }
    const now =
      (data?.serverTime ?? 0) + (connected ? Math.min(4000, performance.now() - observedAt) : 0);
    list.querySelectorAll('[data-planned-index]').forEach((label) => {
      const m = planned[Number(label.dataset.plannedIndex)];
      if (!m) {
        label.textContent = '';
        return;
      }
      const seconds = (planTime(m) - now) / 1000;
      label.dataset.overdue = String(active() && seconds < 0);
      label.textContent = !connected
        ? t('等待连接恢复')
        : !active()
          ? t('尚未交付')
          : seconds >= 0
            ? t('预计还需 {duration}', { duration: duration(seconds) })
            : t('已延期 {duration}', { duration: duration(-seconds) });
    });
  }
  function fileKind(name) {
    if (/\.html?$/i.test(name)) return 'html';
    if (/\.(md|markdown|txt|csv|json)$/i.test(name)) return 'text';
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return 'image';
    if (/\.pdf$/i.test(name)) return 'pdf';
    return 'unsupported';
  }
  function fileUrl(r, path, view = false) {
    const prefix =
      r.previewBase ??
      `${data.artifactBase ?? base}/raw/${encodeURIComponent(sessionId)}/${r.version}/`;
    return prefix + path.split('/').map(encodeURIComponent).join('/') + (view ? '?view=1' : '');
  }
  function renderPreview(force = false) {
    const r = composing ? null : release();
    const entry =
      r &&
      (fileOverride && r.files.some((f) => f.path === fileOverride)
        ? fileOverride
        : r.previewEntry);
    const supported = entry && fileKind(entry) !== 'unsupported';
    const title = r ? (r.title ?? t('成果预览')) : t('成果预览');
    $('preview-title').textContent = r ? `V${r.version} · ${title}` : title;
    $('artifact').hidden = !supported;
    $('preview-empty').hidden = !!supported;
    $('preview-home').disabled = !r;
    $('download').hidden = !r;
    $('open-preview').hidden = !entry;
    $('release-info').hidden = !r;
    $('version-overview').hidden = !r;
    $('release-note').textContent = r ? r.note || t('未记录改动说明') : '';
    if (r) {
      $('download').href = r.downloadUrl;
      $('download').download = `${data.task.title}-v${r.version}.zip`;
    }
    if (entry) $('open-preview').href = fileUrl(r, entry, fileKind(entry) === 'text');
    if (supported) {
      const url = fileUrl(r, entry, fileKind(entry) === 'text');
      if (force || $('artifact').getAttribute('src') !== url) $('artifact').src = url;
    } else {
      $('artifact').removeAttribute('src');
      $('preview-spinner').hidden = !active();
      $('empty-title').textContent = t(
        composing || !data?.task
          ? '让成果先到手，再不断完善。'
          : r
            ? '此文件请独立打开或下载'
            : active()
              ? '正在制作首版'
              : '尚无交付',
      );
      $('empty-copy').textContent = t(
        composing || !data?.task
          ? '描述需求后开始。每次交付都可以预览、下载。'
          : active()
            ? '任务正在推进，可以在左侧继续补充要求。'
            : '已有记录已保留，可以继续对话。',
      );
    }
    if (r && $('release-details').open) renderDetails();
    if (r && $('release-files').open) renderFiles();
  }
  function renderDetails() {
    const r = release();
    if (!r) return;
    $('release-time').textContent = t('实际用时 {duration}', { duration: relative(r.ts) });
    $('check-list').innerHTML = r.checks
      .map(
        (c) =>
          `<div class="check"><strong>${esc(c.label)}</strong><span>${t(c.source === 'agent' ? '模型自检' : '宿主验证')} · ${t(c.result === 'passed' ? '通过' : c.result === 'failed' ? '未通过' : '未验证')}</span>${c.evidence ? `<p>${esc(c.evidence)}</p>` : ''}</div>`,
      )
      .join('');
  }
  function renderFiles() {
    const r = release();
    if (!r) return;
    const filter = $('file-filter').value.toLowerCase();
    $('file-list').innerHTML = r.files
      .filter((f) => f.path.toLowerCase().includes(filter))
      .slice(0, 200)
      .map(
        (f) =>
          `<div class="file-row"><button data-file="${esc(f.path)}">${esc(f.path)}</button><a href="${esc(fileUrl(r, f.path))}?download=1" download>${t('下载')}</a></div>`,
      )
      .join('');
    $('file-list')
      .querySelectorAll('[data-file]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            fileOverride = b.dataset.file;
            persist();
            renderPreview();
            $('preview-panel').scrollIntoView({ block: 'start' });
          }),
      );
  }
  function selectVersion(version) {
    selected = version;
    followLatest = false;
    fileOverride = null;
    persist();
    renderVersions();
    renderPreview(true);
  }
  function render() {
    const state = execution(),
      task = composing ? null : data?.task,
      manager = data?.workbench;
    $('status-label').textContent = t(state.label);
    $('status-label').dataset.state = state.kind;
    $('new-task-button').hidden = !manager?.canCreateTask;
    $('new-task-button').disabled = !connected || busy;
    const catalog = JSON.stringify([manager?.runs, i18n.lang]);
    if ($('run-select').dataset.signature !== catalog) {
      $('run-select').dataset.signature = catalog;
      $('run-select').innerHTML =
        `<option value="">${t('新任务')}</option>` +
        (manager?.runs ?? [])
          .map((r) => `<option value="${esc(r.id)}">${esc(r.title)}</option>`)
          .join('');
    }
    $('run-select').hidden = !manager?.runs?.length;
    $('run-select').value = composing ? '' : (runId ?? '');
    $('workspace-picker').hidden = !composing;
    renderWorkspaceChoices();
    $('budget-label').textContent = t(
      continuing()
        ? '继续执行预算 {duration}'
        : data?.task?.executionCount > 1 && !composing
          ? '本次预算 {duration}'
          : '总预算 {duration}',
      {
        duration: duration(budgetSeconds()),
      },
    );
    $('budget-button').disabled =
      !connected || busy || !(composing || continuing() || data?.capabilities?.settings);
    $('stop-button').hidden = !task || (!data?.capabilities?.wrapUp && state.kind !== 'stopping');
    $('stop-button').disabled = busy || !connected || state.kind === 'stopping';
    $('stop-label').textContent = t(state.kind === 'stopping' ? '正在停止' : '停止任务');
    $('task-title').textContent = task?.title ?? t('开始一次持续交付');
    $('delivery-summary').textContent = task
      ? t('已有 {count} 个可用版本 · 已用 {duration}', {
          count: data.releases.length,
          duration: duration(task.totalElapsedSec ?? task.elapsedSec),
        })
      : t('首版可用，逐版改进。');
    const notices = [];
    if (!connected) notices.push(t('连接中断不代表执行已停止；当前显示最后收到的记录。'));
    if (task && manager?.execution?.error) notices.push(manager.execution.error);
    if (state.kind === 'stopping')
      notices.push(t('停止请求已发送，当前操作结束后收尾。已有版本会保留。'));
    $('state-notice').textContent = notices.join(' ');
    $('state-notice').hidden = !notices.length;
    const canSend =
      connected &&
      (composing ? manager?.canCreateTask : data?.capabilities?.feedback || continuing());
    $('feedback').disabled = !canSend || busy;
    $('send-button').disabled = !canSend || busy;
    $('send-label').textContent = t(
      busy ? '正在发送' : composing ? '开始' : continuing() ? '继续执行' : '发送',
    );
    $('feedback').placeholder = t(
      composing
        ? '描述你想完成的成果…'
        : continuing()
          ? '接下来还想怎么改进？'
          : '下一版想怎么调整？',
    );
    renderFeed();
    renderActivity();
    renderVersions();
    renderPreview();
  }
  function switchRun(id) {
    if (busy) return;
    persist();
    generation++;
    composing = !id;
    runId = id || runId;
    sessionId = id ? null : sessionId;
    feedSignature = '';
    versionsSignature = '';
    newWorkspaceId = null;
    restore();
    if (id) {
      connected = false;
      history.replaceState(null, '', `${base}/?run=${encodeURIComponent(id)}`);
      void poll();
    } else {
      history.replaceState(null, '', `${base}/`);
      safeRender();
    }
  }
  $('new-task-button').onclick = () => switchRun('');
  $('run-select').onchange = () => switchRun($('run-select').value);
  $('task-workspace').onchange = () => {
    newWorkspaceId = null;
    $('workspace-name').hidden = $('task-workspace').value !== 'new';
    persist();
  };
  $('workspace-name').oninput = () => {
    newWorkspaceId = null;
    persist();
  };
  $('feedback').oninput = () => {
    draftId = null;
    if (!budgetDraft?.manual) budgetDraft = null;
    persist();
    $('budget-label').textContent = t(
      continuing()
        ? '继续执行预算 {duration}'
        : data?.task?.executionCount > 1 && !composing
          ? '本次预算 {duration}'
          : '总预算 {duration}',
      {
        duration: duration(budgetSeconds()),
      },
    );
  };
  $('feedback').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!$('send-button').disabled) $('feedback-form').requestSubmit();
    }
  };
  $('feedback-form').onsubmit = async (e) => {
    e.preventDefault();
    if (busy || !connected) return;
    const text = $('feedback').value.trim();
    if (!text) return;
    const current = generation,
      wasNew = composing,
      resume = continuing();
    const seconds = budgetSeconds();
    draftId ??= uid();
    persist();
    busy = true;
    safeRender();
    try {
      if (wasNew || resume) {
        let workspaceId = resume ? data.workbench.workspace.id : $('task-workspace').value;
        if (workspaceId === 'new') {
          const name = $('workspace-name').value.trim();
          if (!name) throw new Error(t('请填写新工作区名称。'));
          if (!newWorkspaceId)
            newWorkspaceId = (await post('workspaces', { name }, true)).workspace.id;
          workspaceId = newWorkspaceId;
        }
        const result = await post(
          'tasks',
          {
            id: draftId,
            workspaceId,
            query: text,
            timeBudgetSec: seconds,
            budgetSource: budgetDraft?.manual ? 'control' : 'request',
            ...(resume ? { parentRunId: runId } : {}),
          },
          true,
        );
        if (current !== generation) return;
        $('feedback').value = '';
        draftId = null;
        budgetDraft = null;
        persist();
        runId = result.taskId ?? result.runId;
        sessionId = result.sessionId;
        composing = false;
        generation++;
        feedSignature = '';
        versionsSignature = '';
        if (wasNew) {
          selected = null;
          followLatest = true;
          fileOverride = null;
        }
        restore();
      } else {
        await post('feedback', { id: draftId, text, ...(selected ? { version: selected } : {}) });
        if (current !== generation) return;
        $('feedback').value = '';
        draftId = null;
        persist();
      }
      await poll();
    } catch (error) {
      toast(
        error.name === 'TimeoutError' ? t('请求超时，尚未确认结果；请稍后重试。') : error.message,
      );
    } finally {
      busy = false;
      safeRender();
    }
  };
  $('budget-button').onclick = () => {
    const seconds = budgetSeconds();
    const unit =
      seconds >= 86400 && seconds % 86400 === 0
        ? 86400
        : seconds >= 3600 && seconds % 3600 === 0
          ? 3600
          : 60;
    budgetContext = {
      generation,
      sessionId,
      kind: composing ? 'new' : continuing() ? 'next' : 'active',
      revision: data?.task?.settingsRevision,
      seconds,
    };
    $('task-budget-unit').value = String(unit);
    $('task-budget').value = String(Number((seconds / unit).toFixed(6)));
    budgetLimits();
    $('budget-title').textContent = t(
      continuing()
        ? '继续执行预算'
        : data?.task?.executionCount > 1 && !composing
          ? '本次预算'
          : '总预算',
    );
    $('budget-help').textContent = t(
      continuing()
        ? '从继续执行时开始计时，已有对话和版本保留。'
        : '达到总预算后收尾，保留最近可用版本。',
    );
    $('budget-error').hidden = true;
    $('budget-dialog').showModal();
    $('task-budget').focus();
  };
  let budgetUnit = 60;
  function budgetLimits() {
    budgetUnit = Number($('task-budget-unit').value);
    $('task-budget').min = String(60 / budgetUnit);
    $('task-budget').max = String(604800 / budgetUnit);
  }
  $('task-budget-unit').onchange = () => {
    const seconds = Math.round(Number($('task-budget').value) * budgetUnit);
    budgetLimits();
    $('task-budget').value = String(Number((seconds / budgetUnit).toFixed(6)));
  };
  $('close-budget').onclick = () => $('budget-dialog').close();
  $('budget-form').onsubmit = async (e) => {
    e.preventDefault();
    const context = budgetContext;
    if (!context || context.generation !== generation || busy) return;
    const seconds = Math.round(
      Number($('task-budget').value) * Number($('task-budget-unit').value),
    );
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 604800) return;
    busy = true;
    $('save-budget').disabled = true;
    try {
      if (context.sessionId !== sessionId)
        throw new Error(t('任务状态已更新，请重新打开预算设置。'));
      if (context.kind === 'active')
        await post('settings', { revision: context.revision, timeBudgetSec: seconds });
      else {
        budgetDraft = { seconds, manual: true };
        persist();
      }
      $('budget-dialog').close();
      await poll();
      toast(t('总预算已保存。'));
    } catch (error) {
      $('budget-error').textContent =
        error.name === 'TimeoutError' ? t('请求超时，尚未确认结果；请稍后重试。') : error.message;
      $('budget-error').hidden = false;
    } finally {
      busy = false;
      $('save-budget').disabled = false;
      safeRender();
    }
  };
  $('stop-button').onclick = async () => {
    if (busy || !connected) return;
    busy = true;
    safeRender();
    try {
      await post('wrap-up', {});
      await poll();
    } catch (error) {
      toast(
        error.name === 'TimeoutError' ? t('请求超时，尚未确认结果；请稍后重试。') : error.message,
      );
    } finally {
      busy = false;
      safeRender();
    }
  };
  $('preview-home').onclick = () => {
    fileOverride = null;
    persist();
    renderPreview(true);
  };
  $('expand-preview').onclick = () => {
    const expanded = $('preview-panel').classList.toggle('is-expanded');
    $('expand-preview').setAttribute('aria-expanded', String(expanded));
    $('expand-preview').setAttribute('aria-label', t(expanded ? '退出放大预览' : '放大预览'));
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('preview-panel').classList.remove('is-expanded');
      $('expand-preview').setAttribute('aria-expanded', 'false');
    }
  });
  $('release-details').ontoggle = () => {
    if ($('release-details').open) renderDetails();
  };
  $('release-files').ontoggle = () => {
    if ($('release-files').open) renderFiles();
  };
  $('file-filter').oninput = renderFiles;
  window.addEventListener('popstate', () => {
    persist();
    const p = new URLSearchParams(location.search);
    runId = p.get('run');
    sessionId = p.get('s');
    composing = !runId && !sessionId;
    generation++;
    restore();
    feedSignature = '';
    versionsSignature = '';
    void poll();
  });
  document.querySelectorAll('[data-lang]').forEach(
    (b) =>
      (b.onclick = () => {
        i18n.setLanguage(b.dataset.lang);
        feedSignature = '';
        versionsSignature = '';
        safeRender();
        if (guideIndex >= 0) showGuideStep();
      }),
  );
  const guideSteps = [
    {
      target: 'feedback',
      title: '在这里描述需求',
      copy: '直接开始制作。想调整下一版的内容或时间，继续在这里说。',
    },
    {
      target: 'versions',
      title: '查看每版成果',
      copy: '点击版本预览成果。已交付版本会保留，随时可以下载。',
    },
    {
      target: 'budget-button',
      title: '掌握总投入',
      copy: '这里设置总预算。需要结束时，点击旁边的停止任务。',
    },
  ];
  const guideKey = `${base}:simple-tour`;
  const guideSeenKey = `${base}:simple-tour-session`;
  const guideSeen = new Set();
  try {
    for (const key of JSON.parse(sessionStorage.getItem(guideSeenKey) || '[]')) guideSeen.add(key);
  } catch (_) {}
  function guideContext() {
    return composing || !data?.releases?.length ? 'start' : 'preview';
  }
  function maybeShowGuide() {
    if (!connected) return;
    if (document.querySelector('dialog[open]')) {
      hideGuide();
      return;
    }
    if (guideIndex >= 0) {
      showGuideStep();
      return;
    }
    try {
      if (localStorage.getItem(guideKey) === 'off') return;
    } catch (_) {}
    const context = guideContext();
    if (guideSeen.has(context)) return;
    guideSeen.add(context);
    try {
      sessionStorage.setItem(guideSeenKey, JSON.stringify([...guideSeen]));
    } catch (_) {}
    guideIndex = context === 'preview' ? 1 : 0;
    $('guide-never').checked = false;
    showGuideStep();
  }
  function hideGuide() {
    const layer = $('guide-layer');
    if (layer.matches(':popover-open')) layer.hidePopover();
    layer.hidden = true;
    guideTarget = null;
    guideIndex = -1;
  }
  function showGuideStep() {
    if (guideIndex < 0) return;
    while (guideIndex < guideSteps.length) {
      const step = guideSteps[guideIndex],
        target = $(step.target);
      if (target && !target.hidden && target.getBoundingClientRect().height) {
        guideTarget = target;
        break;
      }
      guideIndex++;
    }
    if (guideIndex >= guideSteps.length) {
      hideGuide();
      guideIndex = -1;
      return;
    }
    const step = guideSteps[guideIndex];
    $('guide-title').textContent = t(step.title);
    $('guide-copy').textContent = t(step.copy);
    $('guide-layer').hidden = false;
    if (!$('guide-layer').matches(':popover-open')) $('guide-layer').showPopover();
    positionGuide();
  }
  function positionGuide() {
    if (!guideTarget) return;
    const rect = guideTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return hideGuide();
    Object.assign($('guide-highlight').style, {
      left: `${rect.left - 4}px`,
      top: `${rect.top - 4}px`,
      width: `${rect.width + 8}px`,
      height: `${rect.height + 8}px`,
    });
    const tooltip = $('quick-guide'),
      width = Math.min(280, innerWidth - 32);
    tooltip.style.width = `${width}px`;
    const left = Math.max(16, Math.min(rect.left, innerWidth - width - 16));
    const below = rect.bottom + 40;
    const top =
      below + tooltip.offsetHeight < innerHeight - 16
        ? below
        : Math.max(16, rect.top - tooltip.offsetHeight - 38);
    Object.assign(tooltip.style, { left: `${left}px`, top: `${top}px` });
    Object.assign($('guide-hand').style, {
      left: `${Math.min(innerWidth - 42, Math.max(16, rect.left + rect.width / 2 - 10))}px`,
      top: `${Math.max(4, rect.bottom + 2)}px`,
    });
  }
  $('show-guide').onclick = () => {
    $('guide-never').checked = false;
    guideIndex = 0;
    showGuideStep();
  };
  function rememberGuide() {
    try {
      if ($('guide-never').checked) localStorage.setItem(guideKey, 'off');
    } catch (_) {}
  }
  $('guide-skip').onclick = () => {
    rememberGuide();
    guideIndex = -1;
    hideGuide();
  };
  $('guide-next').onclick = () => {
    rememberGuide();
    if ($('guide-never').checked) {
      guideIndex = -1;
      hideGuide();
    } else {
      guideIndex++;
      showGuideStep();
    }
  };
  window.addEventListener('resize', positionGuide);
  document.addEventListener('scroll', positionGuide, true);
  i18n.apply();
  void poll();
  setInterval(() => void poll(), 1500);
  setInterval(() => {
    if (data && !composing) renderVersions();
  }, 500);
})();
