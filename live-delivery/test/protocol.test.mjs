import { requestWrapUp, confirmTurnEnd } from '../.test-build/controls.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callTool, TOOL_SCHEMAS, TOOL_DESCRIPTIONS } from '../.test-build/tools.js';
import {
  beginCd,
  currentState,
  markDone,
  publishVersion,
  runDeadlineTick,
  startTask,
} from '../.test-build/core.js';
import { keepWorkingDecision } from '../.test-build/policy.js';
import { readState, listStates, resolveDeliverable } from '../.test-build/state.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function setup(t, overrides = {}) {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'ld-test-'));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  mkdirSync(path.join(workspaceDir, 'output'));
  writeFileSync(path.join(workspaceDir, 'output/report.md'), '# First report');
  return {
    workspaceDir,
    harness: 'codex',
    instance: 'test',
    sessionKey: 'codex:test',
    port: 18790,
    basePath: '/live-delivery',
    deliverEverySec: 120,
    timeBudgetSec: 1800,
    minWorkingSec: 0,
    minReleases: 1,
    model: 'fixture',
    channels: false,
    ...overrides,
  };
}
const detail = (r) => r.structuredContent;
const text = (r) => r.content.map((c) => c.text).join('\n');

test('four delivery tools expose the publication schema and tool descriptions', () => {
  assert.deepEqual(Object.keys(TOOL_SCHEMAS), ['ld_begin', 'ld_publish', 'ld_status', 'ld_done']);
  assert.deepEqual(Object.keys(TOOL_DESCRIPTIONS), Object.keys(TOOL_SCHEMAS));
  assert.throws(() => TOOL_SCHEMAS.ld_publish.parse({ note: 'Missing publication paths' }));
  assert.throws(() => TOOL_SCHEMAS.ld_begin.parse({ task: 't', outline: [] }));
});
test('begin is idempotent, correctly stamped, and refuses stopped tasks', (t) => {
  const cfg = setup(t);
  const s = beginCd(cfg, 'Report').state;
  assert.equal(s.protocol, 'v1');
  assert.equal(
    s.pluginVersion,
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  );
  assert.equal(beginCd(cfg, 'Different words').state.id, s.id);
  requestWrapUp(cfg, s.id);
  confirmTurnEnd(cfg);
  assert.equal(beginCd(cfg, 'Restart accidentally').ok, false);
  assert.notEqual(startTask(cfg, 'Explicit new request').state.id, s.id);
});
test('state reads require the current protocol and complete session identity', (t) => {
  const cfg = setup(t);
  const state = beginCd(cfg, 'Report').state;
  const file = path.join(cfg.workspaceDir, '.live-delivery', state.id, 'release.json');
  for (const change of [
    { protocol: 'unsupported' },
    { protocol: undefined },
    { id: undefined },
    { id: 'another-task' },
    { name: undefined },
  ]) {
    const raw = JSON.stringify({ ...state, ...change });
    writeFileSync(file, raw);
    assert.equal(readState(cfg.workspaceDir, state.id), null);
    assert.deepEqual(listStates(cfg.workspaceDir), []);
    assert.equal(readFileSync(file, 'utf8'), raw);
  }
  writeFileSync(file, JSON.stringify(state));
  assert.deepEqual(readState(cfg.workspaceDir, state.id), state);
  assert.deepEqual(listStates(cfg.workspaceDir), [state]);
});
test('all-missing or empty directory creates no version, no snapshot, and gives a repair suggestion', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Report');
  const s = currentState(cfg);
  const statePath = path.join(cfg.workspaceDir, '.live-delivery', s.id, 'release.json');
  const before = readFileSync(statePath, 'utf8');
  const fail = callTool(cfg, 'ld_publish', { paths: ['/wrong/report.md'] });
  assert.equal(fail.isError, true);
  assert.equal(detail(fail).version_consumed, false);
  assert.match(text(fail), /pass "output\/report.md" instead/);
  assert.ok(text(fail).includes(cfg.workspaceDir));
  assert.equal(readFileSync(statePath, 'utf8'), before);
  mkdirSync(path.join(cfg.workspaceDir, 'empty'));
  assert.equal(detail(callTool(cfg, 'ld_publish', { paths: ['empty'] })).ok, false);
  assert.equal(existsSync(path.join(cfg.workspaceDir, '.live-delivery', s.id, 'versions')), false);
  assert.equal(
    detail(callTool(cfg, 'ld_publish', { paths: ['output/report.md'] })).published.version,
    1,
  );
});
test('absolute and real workspace aliases publish; unrelated absolute paths are rejected', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Report');
  const alias = cfg.workspaceDir + '-alias';
  symlinkSync(cfg.workspaceDir, alias);
  t.after(() => rmSync(alias));
  for (const p of [
    path.join(cfg.workspaceDir, 'output/report.md'),
    path.join(alias, 'output/report.md'),
  ]) {
    writeFileSync(path.join(cfg.workspaceDir, 'output/report.md'), '# Source path ' + p);
    const r = callTool(cfg, 'ld_publish', { paths: [p] });
    assert.equal(detail(r).n_files, 1);
    assert.deepEqual(detail(r).published.paths, ['output/report.md']);
  }
  assert.equal(
    detail(callTool(cfg, 'ld_publish', { paths: ['/nonexistent/output/report.md'] })).ok,
    false,
  );
  assert.deepEqual(
    currentState(cfg).publishes.map((p) => p.version),
    [1, 2],
  );
});
test('path traversal and symlink escapes cannot publish external files', (t) => {
  const cfg = setup(t);
  assert.equal(resolveDeliverable(cfg.workspaceDir, '../output/report.md'), null);
  assert.equal(resolveDeliverable(cfg.workspaceDir, 'output/../../output/report.md'), null);
  symlinkSync('/etc', path.join(cfg.workspaceDir, 'outside'));
  assert.equal(resolveDeliverable(cfg.workspaceDir, 'outside/passwd'), null);
});
test('partial missing paths fail atomically; valid directory snapshots stay frozen', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Report');
  writeFileSync(path.join(cfg.workspaceDir, 'output/chart.csv'), 'x,y\n1,2');
  const first = callTool(cfg, 'ld_publish', { paths: ['output'], note: 'First' });
  assert.equal(detail(first).n_files, 2);
  writeFileSync(path.join(cfg.workspaceDir, 'output/report.md'), '# Second report');
  const invalid = callTool(cfg, 'ld_publish', { paths: ['output/report.md', 'absent.pdf'] });
  assert.equal(detail(invalid).ok, false);
  assert.equal(currentState(cfg).publishes.length, 1);
  const second = callTool(cfg, 'ld_publish', { paths: ['output/report.md'] });
  assert.equal(detail(second).ok, true);
  assert.equal(detail(second).n_missing, 0);
  assert.deepEqual(detail(second).dropped_paths, ['output']);
  assert.match(text(second), /NOT in this one/);
  const s = currentState(cfg);
  assert.equal(
    readFileSync(
      path.join(cfg.workspaceDir, '.live-delivery', s.id, 'versions/v1/output/report.md'),
      'utf8',
    ),
    '# First report',
  );
  assert.equal(
    readFileSync(
      path.join(cfg.workspaceDir, '.live-delivery', s.id, 'versions/v2/output/report.md'),
      'utf8',
    ),
    '# Second report',
  );
});
test('listing caps at 25, reports full recursive count, and never appends a clock', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Report');
  for (let i = 0; i < 40; i++)
    writeFileSync(path.join(cfg.workspaceDir, `output/file-${i}.txt`), 'x');
  const r = callTool(cfg, 'ld_publish', { paths: ['output'] });
  assert.equal(detail(r).n_files, 41);
  assert.match(text(r), /and 16 more/);
  assert.doesNotMatch(text(r), /budget .* left/);
});
test('deadline misses never publish, rearm from the tick, and retain only 20 misses', (t) => {
  const cfg = setup(t, { timeBudgetSec: 100000 });
  beginCd(cfg, 'Report', {}, 1000000);
  for (let i = 1; i <= 25; i++) runDeadlineTick(cfg, 1000000 + i * 120000);
  const s = currentState(cfg);
  assert.equal(s.publishes.length, 0);
  assert.equal(s.missedDeadlines.length, 20);
  assert.equal(s.nextDeadlineTs, 1000000 + 26 * 120000);
});
test('budget exhaustion requests wrap-up immediately, without claiming the host stopped', (t) => {
  const cfg = setup(t, { timeBudgetSec: 60 });
  beginCd(cfg, 'Report', {}, 1000000);
  publishVersion(cfg, { paths: ['output/report.md'] }, 1000000);
  writeFileSync(path.join(cfg.workspaceDir, 'output/report.md'), 'Unpublished');
  runDeadlineTick(cfg, 1060000);
  assert.equal(currentState(cfg).status, 'delivered');
  assert.equal(currentState(cfg).stopRequest.reason, 'budget');
  assert.equal(currentState(cfg).stopRequest.confirmedTs, undefined);
  runDeadlineTick(cfg, 1120000);
  assert.equal(currentState(cfg).status, 'delivered');
  assert.equal(currentState(cfg).publishes.length, 1);
  assert.equal(keepWorkingDecision(cfg, 1060000).block, false);
});
test('both work floors are required, and budget wins over the Stop gate', (t) => {
  const cfg = setup(t, { minWorkingSec: 60, minReleases: 2 });
  beginCd(cfg, 'Report', {}, 1000000);
  publishVersion(cfg, { paths: ['output/report.md'] }, 1000000);
  assert.equal(keepWorkingDecision(cfg, 1070000).block, true);
  writeFileSync(path.join(cfg.workspaceDir, 'output/report.md'), '# Improved second version');
  publishVersion(cfg, { paths: ['output/report.md'] }, 1001000);
  assert.equal(keepWorkingDecision(cfg, 1030000).block, true);
  assert.equal(markDone(cfg, 'Finished', 1030000).ok, false);
  assert.equal(keepWorkingDecision(cfg, 1070000).block, false);
  assert.equal(
    keepWorkingDecision({ ...cfg, minWorkingSec: 3600, minReleases: 3 }, 2800000).block,
    false,
  );
  assert.equal(markDone(cfg, 'Finished', 1070000).ok, true);
});
test('done forfeits budget without snapshotting unpublished edits or minting a version', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Report');
  publishVersion(cfg, { paths: ['output/report.md'] });
  writeFileSync(path.join(cfg.workspaceDir, 'output/report.md'), 'Not shipped');
  assert.equal(markDone(cfg, 'Complete').ok, true);
  assert.equal(currentState(cfg).publishes.length, 1);
  assert.equal(publishVersion(cfg, { paths: ['output/report.md'] }).ok, false);
  assert.equal(currentState(cfg).status, 'done');
});
test('two host sessions sharing a workspace have independent active tasks and clocks', (t) => {
  const a = setup(t);
  const b = { ...a, sessionKey: 'codex:other' };
  const sa = beginCd(a, 'A', {}, 1000000).state;
  const sb = beginCd(b, 'B', {}, 1000000).state;
  publishVersion(a, { paths: ['output/report.md'] }, 1000000);
  runDeadlineTick(a, 1120000);
  assert.equal(currentState(b).publishes.length, 0);
  assert.equal(currentState(b).missedDeadlines, undefined);
  assert.notEqual(sa.id, sb.id);
  assert.throws(() => requestWrapUp(a, sb.id), /not active/);
});
test('real hook subprocess is quiet at turn start, blocks repeatedly below floor, allows completion', (t) => {
  const cfg = setup(t, { minReleases: 2 });
  beginCd(cfg, 'Report');
  const hook = (event, extra = {}) =>
    spawnSync(process.execPath, [path.join(root, 'dist/hook.mjs')], {
      env: {
        ...process.env,
        QWEN_LD_WORKSPACE: cfg.workspaceDir,
        QWEN_LD_SESSION_KEY: cfg.sessionKey,
        QWEN_LD_INSTANCE_ID: 'test',
      },
      input: JSON.stringify({
        hook_event_name: event,
        session_id: 'test',
        cwd: cfg.workspaceDir,
        ...extra,
      }),
      encoding: 'utf8',
    });
  assert.equal(hook('SessionStart').stdout, '');
  assert.equal(hook('UserPromptSubmit', { prompt: 'Continue' }).stdout, '');
  for (const stop_hook_active of [false, true]) {
    const r = hook('Stop', { stop_hook_active });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  }
  publishVersion(cfg, { paths: ['output/report.md'] });
  writeFileSync(path.join(cfg.workspaceDir, 'output/report.md'), '# Improved second version');
  publishVersion(cfg, { paths: ['output/report.md'] });
  const stopped = hook('Stop', { stop_hook_active: true });
  assert.equal(stopped.status, 0, stopped.stderr);
  const notice = JSON.parse(stopped.stdout);
  assert.equal(notice.decision, undefined, 'Showing the URL must not continue the model');
  assert.match(notice.systemMessage, /DELIVERY DASHBOARD/);
  assert.ok(notice.systemMessage.trimEnd().endsWith('?s=' + currentState(cfg).id));
  assert.ok(
    !notice.systemMessage.includes('\x1b'),
    'Hook JSON must not contain terminal control codes',
  );
});

test('session binding rejects shared-host ambiguity and accepts an explicit clear event', async (t) => {
  const { bindSession, resolveSession } = await import('../.test-build/session-binding.js');
  const cfg = setup(t, {
    sessionKey: undefined,
    instance: `binding-${Date.now()}-${Math.random()}`,
  });
  assert.equal(bindSession(cfg, { sessionId: 'a' }), true);
  assert.equal(resolveSession(cfg).sessionKey, 'codex:a');
  assert.equal(bindSession(cfg, { sessionId: 'b' }), false);
  assert.throws(() => resolveSession(cfg), /ambiguous/);
  assert.equal(bindSession(cfg, { sessionId: 'c', replacesSession: true }), true);
  assert.equal(resolveSession(cfg).sessionKey, 'codex:c');
});

test('Qwen session replacement and resume preserve the right delivery and do not rebind on dashboard reads', async (t) => {
  const { bindSession, resolveSession, persistDashboard, readDashboard } = await import(
    '../.test-build/session-binding.js'
  );
  const { normalizeCommandHook } = await import('../.test-build/command-hook.js');
  const first = setup(t, {
    harness: 'qwen-code',
    sessionKey: undefined,
    instance: 'first-' + Date.now() + Math.random(),
  });
  const resumed = { ...first, instance: 'resumed-' + first.instance };
  const event = (sessionId, source) =>
    normalizeCommandHook(
      {
        hook_event_name: 'SessionStart',
        session_id: sessionId,
        cwd: first.workspaceDir,
        source,
      },
      Date.now(),
    );
  assert.equal(bindSession(first, event('original', 'startup')), true);
  const original = resolveSession(first);
  const task = startTask(original, 'Original task').state;
  assert.equal(bindSession(first, event('cleared', 'clear')), true);
  const cleared = resolveSession(first);
  assert.equal(currentState(cleared), null);
  assert.notEqual(startTask(cleared, 'Another task').state.id, task.id);
  persistDashboard({ ...first, port: 18792, accessToken: 'temporary-test-token' });
  assert.equal(readDashboard({ ...original, instance: first.instance }).port, 18792);
  assert.equal(resolveSession(first).sessionKey, 'qwen-code:cleared');
  assert.equal(bindSession(resumed, event('original', 'resume')), true);
  assert.equal(currentState(resolveSession(resumed)).id, task.id);
  assert.equal(resolveSession(first).sessionKey, 'qwen-code:cleared');
});

test('transcript estimates deduplicate Claude messages and Codex totals, excluding earlier turns', async (t) => {
  const { updateUsageFromTranscript, readUsage } = await import('../.test-build/usage.js');
  const { decodeCodexUsage } = await import('../.test-build/codex-usage.js');
  const { decodeClaudeUsage } = await import('../.test-build/claude-usage.js');
  for (const harness of ['claude-code', 'codex']) {
    const cfg = setup(t, { harness });
    const s = beginCd(cfg, 'Meter', {}, 1000000).state;
    const transcript = path.join(cfg.workspaceDir, 'transcript.jsonl');
    const line = (ts, id, input, output) =>
      JSON.stringify(
        harness === 'claude-code'
          ? {
              timestamp: new Date(ts).toISOString(),
              type: 'assistant',
              message: { id, usage: { input_tokens: input, output_tokens: output } },
            }
          : {
              timestamp: new Date(ts).toISOString(),
              type: 'event_msg',
              payload: {
                type: 'token_count',
                info: { total_token_usage: { input_tokens: input, output_tokens: output } },
              },
            },
      );
    const lines =
      harness === 'claude-code'
        ? [
            line(900000, 'old', 200, 20),
            line(1000100, 'new', 100, 10),
            line(1000200, 'new', 100, 10),
            line(1000300, 'new', 100, 15),
          ]
        : [
            line(900000, '', 200, 20),
            line(1000100, '', 300, 30),
            line(1000200, '', 300, 30),
            line(1000300, '', 300, 35),
          ];
    writeFileSync(transcript, lines.join('\n') + '\n');
    const decode = harness === 'codex' ? decodeCodexUsage : decodeClaudeUsage;
    updateUsageFromTranscript(cfg, transcript, decode);
    updateUsageFromTranscript(cfg, transcript, decode);
    const usage = readUsage(cfg.workspaceDir, s.id);
    assert.equal(usage.input, 100);
    assert.equal(usage.output, 15);
  }
});

test('Codex display inherits CODEX_HOME config without using Claude model variables', async (t) => {
  const { configuredCodexModel } = await import('../.test-build/model.js');
  const cfg = setup(t);
  const env = { CODEX_HOME: cfg.workspaceDir, ANTHROPIC_MODEL: 'claude-only' };
  const file = path.join(cfg.workspaceDir, 'config.toml');
  writeFileSync(
    file,
    "model = 'local-codex-model' # native default\n[model_providers.local]\nmodel = 'not-the-top-level-model'\n",
  );
  assert.equal(configuredCodexModel(env), 'local-codex-model');
  assert.equal(configuredCodexModel({ ...env, QWEN_LD_MODEL: 'explicit-label' }), 'explicit-label');
  writeFileSync(file, 'invalid = [');
  assert.equal(configuredCodexModel(env), 'unknown');
});

test('native hook model updates explicit session bindings and survives model-less hooks', async (t) => {
  const { bindSession, resolveSession } = await import('../.test-build/session-binding.js');
  const cfg = setup(t, {
    instance: `model-${Date.now()}-${Math.random()}`,
    model: 'configured-default',
  });
  bindSession(cfg, {
    sessionId: 'test',
    model: 'native-override',
  });
  assert.equal(resolveSession(cfg).sessionKey, cfg.sessionKey);
  assert.equal(resolveSession(cfg).model, 'native-override');
  bindSession(cfg, {
    sessionId: 'test',
    model: 'switched-model',
  });
  assert.equal(resolveSession(cfg).model, 'switched-model');
  bindSession(cfg, { sessionId: 'test' });
  assert.equal(resolveSession(cfg).model, 'switched-model');
});

test('public $ld:go hook shows onboarding and preserves the original task text', (t) => {
  const cfg = setup(t);
  const result = spawnSync(process.execPath, [path.join(root, 'dist/hook.mjs')], {
    env: {
      ...process.env,
      QWEN_LD_WORKSPACE: cfg.workspaceDir,
      QWEN_LD_SESSION_KEY: cfg.sessionKey,
      QWEN_LD_INSTANCE_ID: 'test',
      QWEN_LD_PORT: '0',
    },
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'test',
      cwd: cfg.workspaceDir,
      prompt: '$ld:go Build the requested page',
    }),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.systemMessage, /DELIVERY DASHBOARD/);
  assert.match(output.hookSpecificOutput.additionalContext, /start producing it immediately/);
  assert.equal(currentState(cfg).task, 'Build the requested page');
});

test('all delivery tool responses, including completion, end with current-session dashboard URLs', (t) => {
  const cfg = setup(t, { bindHost: '127.0.0.1' });
  const first = callTool(cfg, 'ld_begin', { task: 'Linked report' });
  const id = detail(first).state.id;
  for (const response of [
    first,
    callTool(cfg, 'ld_publish', { paths: ['output/report.md'], preview_entry: 'output/report.md' }),
    callTool(cfg, 'ld_status', {}),
    callTool(cfg, 'ld_done', { summary: 'Report delivered' }),
  ]) {
    assert.equal(response.isError, undefined);
    const urls = detail(response).dashboard_urls;
    assert.deepEqual(urls, [`http://127.0.0.1:${cfg.port}${cfg.basePath}/?s=${id}`]);
    assert.ok(text(response).endsWith(urls.at(-1)));
    assert.match(text(response), /\*\*👉 .*DELIVERY DASHBOARD\*\*/);
  }
  startTask(cfg, 'Another report');
  const next = callTool(cfg, 'ld_status', {});
  assert.notEqual(new URL(detail(next).dashboard_urls[0]).searchParams.get('s'), id);
});
