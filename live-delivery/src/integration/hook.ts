import { loadConfig } from './config.js';
import { bindSession, readDashboard, readBoundModel } from './session-binding.js';
import type { CliAdapter, HookResponse } from './cli-adapter.js';
import { deliveryLinks, dashboardFooter, sessionUrl } from '../workbench/browser.js';
import { currentState, startTask, runDeadlineTick } from '../delivery/core.js';
import { keepWorkingDecision } from '../delivery/policy.js';
import { updateUsageFromTranscript } from './usage.js';
import { confirmTurnEnd, recordHostEvent, takeFeedbackContext } from '../delivery/controls.js';
import { nextStep } from '../delivery/instructions.js';

export async function runHook(adapter: CliAdapter): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('Hook input too large.');
    chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
    string,
    unknown
  >;
  const now = Date.now();
  const incoming = adapter.normalizeHook(input, now);
  if (!incoming) return;
  const respond = (response: HookResponse) =>
    process.stdout.write(JSON.stringify(adapter.encodeHook(response, incoming)));
  const seed = loadConfig(adapter, incoming.workspace);
  if (!bindSession(seed, incoming) && !seed.sessionKey) return;
  const sessionKey = seed.sessionKey ?? `${adapter.id}:${incoming.sessionId}`;
  const session = {
    ...seed,
    sessionKey,
    model:
      process.env.QWEN_LD_MODEL ||
      incoming.model ||
      readBoundModel(seed, incoming.sessionId) ||
      seed.model,
  };
  const cfg = readDashboard(session);
  const { name: event, phase } = incoming;
  if (adapter.transcriptUsage && (phase === 'turn-end' || phase === 'prompt'))
    updateUsageFromTranscript(cfg, incoming.transcriptPath, adapter.transcriptUsage);
  recordHostEvent(cfg, incoming, now);
  runDeadlineTick(cfg);
  const handoff = adapter.feedbackHandoff?.();
  if (phase === 'prompt' && handoff) {
    const context = takeFeedbackContext(cfg, event, Date.now(), handoff);
    respond({
      additionalContext:
        context ||
        'Read ld_status before continuing. Preserve this delivery session and obey any stop request.',
    });
    return;
  }
  if (phase === 'turn-end') {
    if (!currentState(cfg)?.stopRequest) {
      const feedback = takeFeedbackContext(cfg, event);
      if (feedback) {
        respond({ blockReason: feedback });
        return;
      }
    }
    const decision = keepWorkingDecision(cfg);
    // stop_hook_active is not an unconditional escape: the work floor must
    // still hold on continuation turns. The wall-clock budget bounds retries;
    // the harness can impose its own independent continuation limit.
    if (!decision.block) confirmTurnEnd(cfg);
    const state = currentState(cfg);
    respond(
      decision.block
        ? { blockReason: decision.reason }
        : { systemMessage: state ? dashboardFooter(cfg, state.id) : undefined },
    );
    return;
  }
  if (phase === 'tool-completed') {
    const feedback = takeFeedbackContext(cfg, event);
    const state = currentState(cfg);
    const wrap =
      state?.stopRequest && !state.stopRequest.confirmedTs ? nextStep(state).message : '';
    if (feedback || wrap)
      respond({ additionalContext: [feedback, wrap].filter(Boolean).join('\n\n') });
    return;
  }
  if (adapter.feedbackOnPrompt && phase === 'prompt' && !incoming.task) {
    const feedback = takeFeedbackContext(cfg, event);
    if (feedback) respond({ additionalContext: feedback });
    return;
  }
  if (incoming.task) {
    const started = startTask(cfg, incoming.task);
    // The SessionStart binding lets MCP start HTTP while this hook is running.
    let ready = cfg;
    let verified = false;
    for (let i = 0; i < 10; i++) {
      try {
        const url = new URL(sessionUrl(ready, started.state?.id ?? ''));
        url.pathname = `${ready.basePath}/api/state`;
        url.hash = '';
        const response = await fetch(url, {
          headers: ready.accessToken ? { Authorization: 'Bearer ' + ready.accessToken } : {},
          signal: AbortSignal.timeout(150),
        });
        const view = response.ok
          ? ((await response.json()) as { task?: { id: string } })
          : undefined;
        if (started.state && view?.task?.id === started.state.id) {
          verified = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
      ready = readDashboard(session);
    }
    const links = verified ? deliveryLinks(ready, started.state?.id) : [];
    const location = links.length
      ? links.join('\n')
      : '网页正在启动，请查看后续工具返回的实际链接。Dashboard starting; subsequent tool results will include its URL.';
    respond({
      systemMessage: `👉 持续交付工作台 / DELIVERY DASHBOARD\n打开工作台查看交付计划、预览成果或追加要求。\n${location}`,
      additionalContext: `Use the installed ld:go skill. Propose the first usable milestone; start producing it immediately. ${process.env.QWEN_LD_EMBEDDED_TASK === '1' ? 'The user is already in the browser workbench. Keep progress messages focused on the work.' : 'Tell the user to open the workbench. End the introduction, delivery notices and final reply with the verified workbench links.'} Dashboard location: ${location}.`,
    });
  }
}
