import { loadConfigForHook, sessionUrl } from './config.js';
import { deliveryLinks, dashboardFooter } from './browser.js';
import { currentState, startTask, runDeadlineTick } from './core.js';
import { keepWorkingDecision } from './policy.js';
import { updateUsageFromTranscript } from './usage.js';
import { confirmTurnEnd, recordHook, takeFeedbackContext } from './controls.js';
import { nextStep } from './instructions.js';

async function main(): Promise<void> {
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
  if (input.agent_id || input.agent_type) return; // never bind a subagent to the main task
  const cfg = loadConfigForHook(input);
  if (!cfg.sessionKey) return;
  const event = input.hook_event_name;
  if (event === 'Stop' || event === 'UserPromptSubmit')
    updateUsageFromTranscript(
      cfg,
      typeof input.transcript_path === 'string' ? input.transcript_path : undefined,
    );
  recordHook(cfg, input);
  runDeadlineTick(cfg);
  if (event === 'UserPromptSubmit' && process.env.QWEN_LD_FEEDBACK_HANDOFF) {
    const context = takeFeedbackContext(
      cfg,
      'UserPromptSubmit',
      Date.now(),
      process.env.QWEN_LD_FEEDBACK_HANDOFF,
    );
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext:
            context ||
            'Read ld_status before continuing. Preserve this delivery session and obey any stop request.',
        },
      }),
    );
    return;
  }
  if (event === 'Stop') {
    if (!currentState(cfg)?.stopRequest) {
      const feedback = takeFeedbackContext(cfg, 'Stop');
      if (feedback) {
        process.stdout.write(JSON.stringify({ decision: 'block', reason: feedback }));
        return;
      }
    }
    const decision = keepWorkingDecision(cfg);
    // stop_hook_active is not an unconditional escape: the work floor must
    // still hold on continuation turns. The wall-clock budget bounds retries;
    // the harness can impose its own independent continuation limit.
    if (!decision.block) confirmTurnEnd(cfg);
    const state = currentState(cfg);
    process.stdout.write(
      JSON.stringify(
        decision.block
          ? { decision: 'block', reason: decision.reason }
          : state
            ? { systemMessage: dashboardFooter(cfg, state.id) }
            : {},
      ),
    );
    return;
  }
  if (event === 'PostToolUse') {
    const feedback = takeFeedbackContext(cfg, 'PostToolUse');
    const state = currentState(cfg);
    const wrap =
      state?.stopRequest && !state.stopRequest.confirmedTs ? nextStep(state).message : '';
    if (feedback || wrap)
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: [feedback, wrap].filter(Boolean).join('\n\n'),
          },
        }),
      );
    return;
  }
  if (event !== 'UserPromptSubmit' && event !== 'SessionStart') return;
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  // Codex invokes plugin skills as `$ld:go`; Claude Code as the `/ld:go` command.
  const command =
    cfg.harness === 'claude-code'
      ? /^\s*\/ld:go(?:\s+([\s\S]*)|$)/
      : /^\s*\$ld:go(?:\s+([\s\S]*)|$)/;
  const match = command.exec(prompt);
  if (match?.[1]?.trim()) {
    const started = startTask(cfg, match[1].trim());
    // The SessionStart binding lets MCP start HTTP while this hook is running.
    let ready = loadConfigForHook(input);
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
      ready = loadConfigForHook(input);
    }
    const links = verified ? deliveryLinks(ready, started.state?.id) : [];
    const location = links.length
      ? links.join('\n')
      : '网页正在启动，请查看后续工具返回的实际链接。Dashboard starting; subsequent tool results will include its URL.';
    process.stdout.write(
      JSON.stringify({
        systemMessage: `👉 持续交付工作台 / DELIVERY DASHBOARD\n打开工作台查看交付计划、预览成果或追加要求。\n${location}`,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `Use the installed ld:go skill. Propose the first usable milestone; start producing it immediately. ${process.env.QWEN_LD_EMBEDDED_TASK === '1' ? 'The user is already in the browser workbench. Keep progress messages focused on the work.' : 'Tell the user to open the workbench. End the introduction, delivery notices and final reply with the verified workbench links.'} Dashboard location: ${location}.`,
        },
      }),
    );
  }
}
main().catch((error) => {
  process.stderr.write(`[live-delivery hook] ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
