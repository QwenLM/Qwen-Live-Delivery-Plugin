import {
  beginFeedbackHandoff,
  prepareFeedbackResume,
  cancelFeedbackHandoff,
} from '../.test-build/feedback-handoff.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginCd, currentState, publishVersion } from '../.test-build/core.js';
import {
  queueFeedback,
  takeFeedbackContext,
  changeSettings,
  requestWrapUp,
  recordHostEvent,
} from '../.test-build/controls.js';
import { callTool } from '../.test-build/tools.js';
import { buildReadModel } from '../.test-build/read-model.js';
import { loadConfig } from '../.test-build/config.js';
import { codexCli } from '../.test-build/cli.js';
function setup(t) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-simple-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const cfg = {
    workspaceDir,
    harness: 'codex',
    instance: 'simple',
    sessionKey: 'simple',
    basePath: '/live-delivery',
    port: 0,
    timeBudgetSec: 600,
    deliverEverySec: 120,
    minWorkingSec: 0,
    minReleases: 1,
    planMode: 'rolling',
    requirePlanApproval: false,
  };
  const milestone = {
    id: 'first',
    title: 'First',
    scope: 'Interactive reference',
    acceptance: ['Opens'],
    target_after: '1m',
  };
  const first = beginCd(cfg, 'The complete objective', { milestones: [milestone] }).state;
  fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<h1>Original diagram</h1>');
  return { cfg, milestone, first };
}
test('chat changes the next version without altering snapshots or enlarging the budget', (t) => {
  const { cfg, milestone, first } = setup(t);
  const revision = {
    ...milestone,
    title: 'Illustrated comparison',
    scope: 'Original diagrams requested in chat',
    acceptance: ['Diagrams explained'],
    target_after: '2m',
    reason: 'Updated the next version from your request.',
    feedback_ids: ['user-style'],
  };
  const change = () =>
    callTool(cfg, 'ld_begin', { task: first.task, plan_revision: 1, revise_milestone: revision });
  assert.equal(change().isError, true, 'Invented feedback cannot authorize a change');
  queueFeedback(cfg, first.id, {
    id: 'user-style',
    text: 'Use original illustrated diagrams and explain them.',
  });
  assert.equal(change().isError, true, 'Queued feedback must reach the Agent first');
  takeFeedbackContext(cfg, 'PostToolUse');
  assert.equal(change().structuredContent.ok, true);
  const next = currentState(cfg);
  assert.equal(next.milestones[0].title, revision.title);
  assert.equal(next.milestones[0].scope, revision.scope);
  assert.deepEqual(next.milestones[0].acceptance, revision.acceptance);
  assert.equal(next.milestones[0].targetTs, first.milestones[0].targetTs);
  assert.equal(next.timeBudgetSec, first.timeBudgetSec);
  assert.equal(next.planRevision, 2);
  assert.equal(next.feedback[0].status, 'injected');
  assert.equal(change().isError, true, 'Concurrent stale revision is rejected');
  const publish = {
    paths: ['index.html'],
    preview_entry: 'index.html',
    milestone_id: 'first',
    checks: [{ label: 'Diagrams explained', result: 'passed' }],
    feedback_ids: ['user-style'],
  };
  assert.equal(publishVersion(cfg, { ...publish, plan_revision: 1 }).ok, false);
  assert.equal(publishVersion(cfg, publish).ok, false);
  assert.equal(publishVersion(cfg, { ...publish, plan_revision: 2 }).ok, true);
  assert.equal(currentState(cfg).feedback[0].status, 'addressed');
  assert.equal(
    callTool(cfg, 'ld_begin', { task: first.task, plan_revision: 2, revise_milestone: revision })
      .isError,
    true,
  );
  assert.equal(currentState(cfg).publishes.length, 1);
});
test('one user budget control works with a plan, preserves its targets and rejects stale updates', (t) => {
  const { cfg, first } = setup(t);
  const old = first.milestones[0].targetTs;
  assert.equal(
    changeSettings(cfg, first.id, { timeBudgetSec: 1200, revision: 1 }).timeBudgetSec,
    1200,
  );
  assert.equal(currentState(cfg).milestones[0].targetTs, old);
  assert.throws(
    () => changeSettings(cfg, first.id, { timeBudgetSec: 1800, revision: 1 }),
    /changed/,
  );
  assert.equal(
    beginCd(cfg, first.task, { timeBudgetSec: 1500 }).ok,
    false,
    'Model cannot enlarge the authorized budget',
  );
  const view = buildReadModel(cfg, currentState(cfg), 'fixture');
  assert.equal(view.capabilities.settings, true);
  assert.equal(view.capabilities.plan, false);
  assert.match(takeFeedbackContext(cfg, 'PostToolUse'), /1200/);
  const feedbackId = currentState(cfg).feedback.at(-1).id;
  assert.equal(
    callTool(cfg, 'ld_begin', {
      task: first.task,
      plan_revision: 1,
      revise_milestone: {
        id: 'first',
        title: 'Reprioritized result',
        scope: 'A useful result within the new budget',
        acceptance: ['Opens'],
        target_after: '2m',
        reason: 'Replanned for the updated time budget.',
        feedback_ids: [feedbackId],
      },
    }).structuredContent.ok,
    true,
  );
  requestWrapUp(cfg, first.id);
  assert.throws(
    () => changeSettings(cfg, first.id, { timeBudgetSec: 1800, revision: 2 }),
    /running/,
  );
});
test('retired environment options cannot enable approval gates or fixed plans for new CLI tasks', (t) => {
  const { cfg } = setup(t);
  const names = [
    'QWEN_LD_REQUIRE_PLAN_APPROVAL',
    'QWEN_LD_PLAN_MODE',
    'QWEN_LD_MIN_WORKING',
    'QWEN_LD_MIN_RELEASES',
  ];
  const previous = names.map((n) => process.env[n]);
  try {
    Object.assign(process.env, {
      QWEN_LD_REQUIRE_PLAN_APPROVAL: '1',
      QWEN_LD_PLAN_MODE: 'fixed',
      QWEN_LD_MIN_WORKING: '1h',
      QWEN_LD_MIN_RELEASES: '50',
    });
    const loaded = loadConfig(codexCli, cfg.workspaceDir);
    assert.equal(loaded.requirePlanApproval, false);
    assert.equal(loaded.planMode, 'rolling');
    assert.equal(loaded.minWorkingSec, 0);
    assert.equal(loaded.minReleases, 1);
  } finally {
    names.forEach((n, i) =>
      previous[i] === undefined ? delete process.env[n] : (process.env[n] = previous[i]),
    );
  }
});

test('interruption batches new feedback and acknowledges it only in the resumed turn', (t) => {
  const { cfg, first } = setup(t);
  queueFeedback(cfg, first.id, { id: 'change-one', text: 'Use a tablet.' });
  const handoff = beginFeedbackHandoff(cfg, '00000000-0000-4000-8000-000000000001');
  assert.ok(handoff);
  assert.equal(takeFeedbackContext(cfg, 'PostToolUse'), '');
  recordHostEvent(cfg, { name: 'Interrupt', pauseReason: 'interrupt' });
  assert.equal(currentState(cfg).status, first.status);
  queueFeedback(cfg, first.id, { id: 'change-two', text: 'Include a stylus.' });
  assert.ok(prepareFeedbackResume(cfg, handoff.id));
  assert.equal(takeFeedbackContext(cfg, 'UserPromptSubmit', Date.now(), 'wrong-handoff'), '');
  const context = takeFeedbackContext(cfg, 'UserPromptSubmit', Date.now(), handoff.id);
  assert.match(context, /Use a tablet/);
  assert.match(context, /Include a stylus/);
  const state = currentState(cfg);
  assert.equal(state.feedbackHandoff, undefined);
  assert.equal(state.feedback.length, 2);
  assert.ok(
    state.feedback.every((f) => f.status === 'injected' && f.hookEvent === 'UserPromptSubmit'),
  );
  assert.equal(state.startedTs, first.startedTs);
  assert.equal(state.timeBudgetSec, first.timeBudgetSec);
  assert.equal(takeFeedbackContext(cfg, 'PostToolUse'), '');
});

test('user stop cancels automatic feedback resume without losing the message', (t) => {
  const { cfg, first } = setup(t);
  queueFeedback(cfg, first.id, { id: 'stop-change', text: 'Change direction.' });
  const handoff = beginFeedbackHandoff(cfg, '00000000-0000-4000-8000-000000000001');
  requestWrapUp(cfg, first.id);
  assert.equal(prepareFeedbackResume(cfg, handoff.id), false);
  assert.equal(takeFeedbackContext(cfg, 'UserPromptSubmit', Date.now(), handoff.id), '');
  recordHostEvent(cfg, { name: 'Interrupt', pauseReason: 'interrupt' });
  cancelFeedbackHandoff(cfg, handoff.id);
  const state = currentState(cfg);
  assert.equal(state.status, 'paused');
  assert.equal(state.stopRequest.reason, 'user');
  assert.equal(state.feedback[0].status, 'queued');
  assert.equal(state.feedbackHandoff, undefined);
});
