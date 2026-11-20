import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginCd,
  currentState,
  publishVersion,
  markDone,
  runDeadlineTick,
} from '../.test-build/core.js';
import { changeSettings, requestWrapUp } from '../.test-build/controls.js';
import { buildReadModel } from '../.test-build/read-model.js';
import { keepWorkingDecision } from '../.test-build/policy.js';
import { loadConfig } from '../.test-build/config.js';
import { requestedBudget } from '../.test-build/budget.js';
const epoch = 1000000;
const milestone = (id, target = '1m') => ({
  id,
  title: id,
  scope: 'Usable new capability',
  acceptance: ['Opens'],
  target_after: target,
});
function setup(t) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-rolling-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const cfg = {
    workspaceDir,
    harness: 'codex',
    instance: 'rolling',
    sessionKey: 'codex:rolling',
    basePath: '/live-delivery',
    port: 0,
    deliverEverySec: 60,
    timeBudgetSec: 3600,
    minWorkingSec: 0,
    minReleases: 1,
    planMode: 'rolling',
  };
  return cfg;
}
function publish(cfg, id, n, now) {
  fs.writeFileSync(path.join(cfg.workspaceDir, 'index.html'), `<h1>Usable capability ${n}</h1>`);
  return publishVersion(
    cfg,
    {
      paths: ['index.html'],
      preview_entry: 'index.html',
      milestone_id: id,
      checks: [{ label: 'Opens', result: 'passed' }],
    },
    now,
  );
}
test('rolling plans one version at a time, continues past 24 deliveries, and stops on user request', (t) => {
  const cfg = setup(t);
  assert.equal(
    beginCd(cfg, 'Build', { milestones: [milestone('v1'), milestone('v2')] }, epoch).ok,
    false,
  );
  assert.equal(beginCd(cfg, 'Build', { milestones: [milestone('v1')] }, epoch).ok, true);
  for (let n = 1; n <= 30; n++) {
    const now = epoch + n * 10000;
    const result = publish(cfg, `v${n}`, n, now);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.state.published.version, n);
    assert.equal(markDone(cfg, 'All planned nodes delivered', now + 1).ok, false);
    assert.equal(keepWorkingDecision(cfg, now + 1).block, true);
    const view = buildReadModel(cfg, currentState(cfg), 'test', now + 1);
    assert.equal(view.task.awaitingNextPlan, true);
    assert.equal(view.planReview.autoExecuting, true);
    const next = beginCd(
      cfg,
      'Build',
      {
        nextMilestone: milestone(`v${n + 1}`, `${n * 10 + 20}s`),
        planRevision: result.state.planRevision ?? 1,
      },
      now + 2,
    );
    assert.equal(next.ok, true, next.error);
    assert.equal(next.state.approvalPendingSinceTs, undefined);
    assert.equal(
      next.state.planConfirmations,
      undefined,
      'Later plans must not fabricate new user approvals',
    );
  }
  const original = path.join(
    cfg.workspaceDir,
    '.live-delivery',
    currentState(cfg).id,
    'versions/v1/index.html',
  );
  assert.match(fs.readFileSync(original, 'utf8'), /capability 1</);
  requestWrapUp(cfg, currentState(cfg).id, 'user', epoch + 400000);
  assert.equal(markDone(cfg, 'Keep the best usable snapshot', epoch + 400001).ok, true);
});
test('rolling plan appends reject pending work, stale edits, reused IDs and budget overruns', (t) => {
  const cfg = setup(t);
  const first = beginCd(cfg, 'Build', { milestones: [milestone('first')] }, epoch).state;
  assert.equal(
    beginCd(cfg, 'Build', { nextMilestone: milestone('next'), planRevision: 1 }, epoch + 1).ok,
    false,
  );
  publish(cfg, 'first', 1, epoch + 2000);
  assert.equal(
    beginCd(
      cfg,
      'Build',
      { nextMilestone: milestone('second', '30s'), planRevision: 1 },
      epoch + 3000,
    ).ok,
    true,
  );
  for (const revision of [1, 2])
    assert.equal(
      beginCd(
        cfg,
        'Build',
        { nextMilestone: milestone('next'), planRevision: revision },
        epoch + 4000,
      ).ok,
      false,
    );
  assert.equal(publish(cfg, 'second', 2, epoch + 5000).ok, true);
  const revision = currentState(cfg).planRevision;
  assert.equal(
    beginCd(
      cfg,
      'Build',
      { nextMilestone: milestone('second'), planRevision: revision },
      epoch + 6000,
    ).ok,
    false,
  );
  assert.equal(
    beginCd(
      cfg,
      'Build',
      { nextMilestone: milestone('too-late', '2h'), planRevision: revision },
      epoch + 6000,
    ).ok,
    false,
  );
  assert.equal(
    beginCd(
      cfg,
      'Build',
      { nextMilestone: milestone('next'), planRevision: revision },
      epoch + 6000,
    ).ok,
    true,
  );
  runDeadlineTick(cfg, epoch + 3600001);
  assert.equal(currentState(cfg).stopRequest.reason, 'budget');
  assert.equal(keepWorkingDecision(cfg, epoch + 3600001).block, false);
  assert.equal(markDone(cfg, 'Time elapsed', epoch + 3600002).ok, true);
});
test('a rough candidate cannot be published as usable without passing each acceptance check', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Build', { milestones: [milestone('first')] }, epoch);
  fs.writeFileSync(path.join(cfg.workspaceDir, 'index.html'), '<h1>Not checked</h1>');
  for (const checks of [
    [],
    [{ label: 'Opens', result: 'failed' }],
    [{ label: 'Opens', result: 'not_run' }],
  ])
    assert.equal(
      publishVersion(cfg, { paths: ['index.html'], milestone_id: 'first', checks }, epoch + 1).ok,
      false,
    );
  assert.equal(currentState(cfg).publishes.length, 0);
  assert.equal(publish(cfg, 'first', 1, epoch + 1000).state.published.version, 1);
});
test('conflicting results for one acceptance criterion do not consume a version', (t) => {
  const cfg = setup(t);
  const { state } = beginCd(cfg, 'Build', { milestones: [milestone('first')] }, epoch);
  fs.writeFileSync(path.join(cfg.workspaceDir, 'index.html'), '<h1>Counter</h1>');
  const input = { paths: ['index.html'], preview_entry: 'index.html', milestone_id: 'first' };
  const passed = { label: 'Opens', result: 'passed' };
  for (const checks of [
    [{ label: 'Opens', result: 'failed' }, passed],
    [passed, { label: 'Opens', result: 'not_run' }],
  ]) {
    const result = publishVersion(cfg, { ...input, checks }, epoch + 1);
    assert.equal(result.ok, false);
    assert.match(result.error, /Conflicting results.*"Opens"/);
    assert.equal(result.version_consumed, false);
    assert.equal(currentState(cfg).published, undefined);
    assert.equal(currentState(cfg).publishes.length, 0);
    assert.equal(
      fs.existsSync(path.join(cfg.workspaceDir, '.live-delivery', state.id, 'versions/v1')),
      false,
    );
  }
  const corrected = publishVersion(cfg, { ...input, checks: [passed] }, epoch + 2);
  assert.equal(corrected.ok, true, corrected.error);
  assert.equal(corrected.state.published.version, 1);
});
test('task duration recognition does not confuse video length or per-version intervals with total time', () => {
  for (const [text, seconds] of [
    ['总时间3分钟', 180],
    ['请用3分钟完成一个实验', 180],
    ['total budget: 2 hours', 7200],
    ['Complete this task within 4 min', 240],
    ['总执行时间为0.5小时', 1800],
    ['总时间3分钟，改为总时间5分钟', 300],
  ])
    assert.equal(requestedBudget(text), seconds, text);
  for (const text of [
    '制作一个3分钟的视频',
    '每3分钟交付一版',
    '模拟运动3分钟',
    'a 3 minute video',
    '总时间10天',
  ])
    assert.equal(requestedBudget(text), undefined, text);
});

test('default configuration starts rolling delivery without fabricating user approval', (t) => {
  const cfg = setup(t);
  const previous = process.env.QWEN_LD_REQUIRE_PLAN_APPROVAL;
  try {
    delete process.env.QWEN_LD_REQUIRE_PLAN_APPROVAL;
    assert.equal(loadConfig(cfg.workspaceDir).requirePlanApproval, false);
    process.env.QWEN_LD_REQUIRE_PLAN_APPROVAL = '1';
    assert.equal(loadConfig(cfg.workspaceDir).requirePlanApproval, false);
    process.env.QWEN_LD_REQUIRE_PLAN_APPROVAL = '0';
    cfg.requirePlanApproval = loadConfig(cfg.workspaceDir).requirePlanApproval;
  } finally {
    if (previous === undefined) delete process.env.QWEN_LD_REQUIRE_PLAN_APPROVAL;
    else process.env.QWEN_LD_REQUIRE_PLAN_APPROVAL = previous;
  }
  assert.equal(beginCd(cfg, 'Build', { milestones: [milestone('v1')] }, epoch).ok, true);
  let view = buildReadModel(cfg, currentState(cfg), 'test', epoch);
  assert.equal(view.task.awaitingPlanApproval, false);
  assert.equal(view.planReview.autoExecuting, true);
  assert.equal(view.planReview.confirmed, false);
  assert.equal(view.planReview.confirmation, null);
  assert.equal(publish(cfg, 'v1', 1, epoch + 1000).ok, true);
  view = buildReadModel(cfg, currentState(cfg), 'test', epoch + 1001);
  assert.equal(view.task.awaitingNextPlan, true);
  assert.equal(view.planReview.confirmation, null);
});

test('a user budget change updates the running task and rejects stale writes', (t) => {
  const cfg = setup(t);
  const state = beginCd(cfg, 'Build', { milestones: [milestone('first')] }, epoch).state;
  const updated = changeSettings(cfg, state.id, { revision: 1, timeBudgetSec: 180 }, epoch + 1000);
  assert.equal(updated.timeBudgetSec, 180);
  assert.equal(buildReadModel(cfg, updated, 'test', epoch + 1000).task.timeBudgetSec, 180);
  assert.throws(
    () => changeSettings(cfg, state.id, { revision: 1, timeBudgetSec: 240 }),
    /changed/,
  );
  assert.equal(beginCd(cfg, 'Build', { timeBudgetSec: 240 }, epoch + 1001).ok, false);
});
