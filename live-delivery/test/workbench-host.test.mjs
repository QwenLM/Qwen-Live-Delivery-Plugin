import { authorize, fetch } from './http-client.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexWorkbench } from '../.test-build/dashboard.js';
import { beginCd, publishVersion, markDone } from '../.test-build/core.js';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pause = () => new Promise((r) => setTimeout(r, 70));
async function until(fn) {
  for (let i = 0; i < 140; i++) {
    const v = await fn();
    if (v) return v;
    await pause();
  }
  throw new Error('Timed out');
}
async function setup(t, env = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-workbench-'));
  const options = {
    planMode: 'fixed',
    stateDir: path.join(temp, 'private'),
    workspaceRoot: path.join(temp, 'workspaces'),
    pluginRoot: root,
    codexHome: path.join(temp, 'auth-home'),
    codexBin: path.join(root, 'test/workbench-fixture.mjs'),
  };
  const hosts = [];
  const start = async () => {
    const host = createCodexWorkbench(options, { PATH: process.env.PATH, ...env });
    hosts.push(host);
    await new Promise((r) => host.server.listen(0, '127.0.0.1', r));
    return host;
  };
  t.after(async () => {
    for (const w of fs.readdirSync(options.workspaceRoot, { withFileTypes: true }))
      if (w.isDirectory())
        fs.writeFileSync(path.join(options.workspaceRoot, w.name, '.finish-fixture'), 'done');
    await new Promise((r) => setTimeout(r, 250));
    for (const h of hosts) if (h.server.listening) await h.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const host = await start();
  return { host, options, start };
}
function client(host) {
  const origin = `http://127.0.0.1:${host.server.address().port}`,
    base = origin + '/live-delivery';
  authorize(origin, host.access.token);
  return {
    origin,
    base,
    post: async (action, value, extra = {}) =>
      fetch(base + '/api/' + action, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'X-CD-Token': host.token,
          ...extra,
        },
        body: JSON.stringify(value),
      }),
    state: async (run) => {
      const r = await fetch(base + '/api/state' + (run ? '?run=' + run : ''));
      return r.json();
    },
  };
}

test('web host creates isolated workspaces, runs native child processes in parallel, rejects shared-workspace conflicts and preserves idempotency', async (t) => {
  const { host, options } = await setup(t),
    c = client(host);
  assert.equal((await c.state()).workbench.canCreateTask, true);
  assert.equal((await c.post('workspaces', { name: 'blocked' }, { Origin: 'null' })).status, 403);
  assert.equal((await c.post('workspaces', { name: '../escape' })).status, 409);
  const a = (await (await c.post('workspaces', { name: 'case-a' })).json()).workspace,
    b = (await (await c.post('workspaces', { name: 'case-b' })).json()).workspace;
  const request = { id: 'request-case-a', workspaceId: a.id, query: 'Build A', timeBudgetSec: 300 };
  const started = await (await c.post('tasks', request)).json();
  assert.ok(started.ok);
  assert.equal((await (await c.post('tasks', request)).json()).runId, started.runId);
  assert.equal((await c.post('tasks', { ...request, id: 'different-task' })).status, 409);
  const second = await (
    await c.post('tasks', { ...request, id: 'request-case-b', workspaceId: b.id, query: 'Build B' })
  ).json();
  assert.ok(second.ok);
  const states = await until(async () => {
    const x = await c.state(started.runId),
      y = await c.state(second.runId);
    return x.releases?.length && y.releases?.length ? [x, y] : null;
  });
  assert.equal(states[0].task.request, 'Build A');
  assert.equal(states[1].task.request, 'Build B');
  assert.notEqual(states[0].artifactBase, states[1].artifactBase);
  assert.match(
    await (await fetch(c.origin + states[0].releases[0].previewUrl)).text(),
    /case-a v1/,
  );
  assert.match(
    await (await fetch(c.origin + states[1].releases[0].previewUrl)).text(),
    /case-b v1/,
  );
  const cross = states[0].artifactBase + '/raw/' + states[1].task.id + '/1/output/index.html';
  assert.equal((await fetch(c.origin + cross)).status, 400);
  const feedback = await fetch(c.origin + states[0].controlBase + '/api/feedback', {
    method: 'POST',
    headers: { Origin: c.origin, 'Content-Type': 'application/json', 'X-CD-Token': host.token },
    body: JSON.stringify({
      session_id: states[0].task.id,
      id: 'feedback-case-a',
      text: 'Only case A receives this',
    }),
  });
  assert.equal(feedback.status, 200);
  await until(() => fs.existsSync(path.join(a.path, 'received-feedback.txt')));
  assert.match(fs.readFileSync(path.join(a.path, 'received-feedback.txt'), 'utf8'), /Only case A/);
  assert.equal(fs.existsSync(path.join(b.path, 'received-feedback.txt')), false);
  assert.equal((await fetch(c.base + '/r/' + started.runId + '/config.toml')).status, 404);
  assert.equal((await c.state(started.runId)).workbench.workspace.path, a.path);
  fs.writeFileSync(path.join(a.path, '.finish-fixture'), 'done');
  fs.writeFileSync(path.join(b.path, '.finish-fixture'), 'done');
  await until(async () => (await c.state(started.runId)).task.status === 'done');
  assert.equal((await c.state(started.runId)).releases.length, 1);
});

test('a web host restart reconnects to the same running task and preserves its preview', async (t) => {
  const { host, start, options } = await setup(t);
  let c = client(host);
  const w = (await (await c.post('workspaces', { name: 'resume-case' })).json()).workspace;
  const run = await (
    await c.post('tasks', {
      id: 'request-resume-case',
      workspaceId: w.id,
      query: 'Resume case',
      timeBudgetSec: 300,
    })
  ).json();
  const before = await until(async () => {
    const s = await c.state(run.runId);
    return s.releases?.length ? s : null;
  });
  await host.close();
  const replacement = await start();
  c = client(replacement);
  const extra = (await (await c.post('workspaces', { name: 'created-after-restart' })).json())
    .workspace;
  const state = await c.state(run.runId);
  assert.equal(state.task.id, before.task.id);
  assert.equal(state.capabilities.readOnly, false);
  const preview = await fetch(new URL(state.releases[0].previewUrl, c.origin));
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /resume-case v1/);
  fs.writeFileSync(path.join(w.path, '.finish-fixture'), 'done');
  await until(async () => (await c.state(run.runId)).task.status === 'done');
  assert.equal((await c.state(run.runId)).releases.length, 1);
  await until(
    () =>
      !JSON.parse(fs.readFileSync(path.join(options.stateDir, 'registry.json'), 'utf8')).runs.some(
        (r) => r.id === run.runId && r.status === 'running',
      ),
  );
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(
    JSON.parse(
      fs.readFileSync(path.join(options.stateDir, 'registry.json'), 'utf8'),
    ).workspaces.some((w) => w.id === extra.id),
    'An old child exit must not overwrite the replacement host registry',
  );
});

test('failed child execution is reported honestly and a private directory cannot be selected as a workspace', async (t) => {
  const { host, options } = await setup(t),
    c = client(host);
  fs.symlinkSync(options.stateDir, path.join(options.workspaceRoot, 'private-link'));
  assert.equal((await c.post('workspaces', { name: 'private-link' })).status, 409);
  const w = (await (await c.post('workspaces', { name: 'failure-case' })).json()).workspace;
  const run = await (
    await c.post('tasks', {
      id: 'request-failure-case',
      workspaceId: w.id,
      query: '[FAIL]',
      timeBudgetSec: 300,
    })
  ).json();
  const state = await until(async () => {
    const s = await c.state(run.runId);
    return s.workbench?.execution.status === 'failed' ? s : null;
  });
  assert.equal(state.task.status, 'paused');
  assert.equal(state.releases.length, 0);
  assert.equal(state.capabilities.feedback, false);
  assert.ok(state.workbench.execution.error);
});

test('completed conversations keep one task, full previews and immutable history across restart', async (t) => {
  const { host, start } = await setup(t);
  let c = client(host);
  const { workspace } = await (await c.post('workspaces', { name: 'continuation' })).json();
  let parentRunId, taskId;
  let firstFile, original;
  for (let version = 1; version <= 3; version++) {
    const request = {
      id: 'continue-round-' + version,
      workspaceId: workspace.id,
      query: version === 1 ? 'Original objective' : 'Add a comparison',
      timeBudgetSec: 300,
      ...(parentRunId ? { parentRunId } : {}),
    };
    const run = await (await c.post('tasks', request)).json();
    assert.equal((await (await c.post('tasks', request)).json()).runId, run.runId);
    const state = await until(async () => {
      const s = await c.state(run.runId);
      return s.releases?.at(-1)?.version === version ? s : null;
    });
    taskId ??= run.taskId;
    assert.equal(run.taskId, taskId);
    assert.equal(state.workbench.selectedRun, taskId);
    assert.equal(state.workbench.runs.length, 1);
    assert.equal(state.workbench.previousRounds, undefined);
    assert.deepEqual(
      state.releases.map((r) => r.version),
      Array.from({ length: version }, (_, i) => i + 1),
    );
    assert.equal((await c.state(taskId)).task.id, state.task.id);
    assert.equal(state.messages[0].text, 'Original objective');
    assert.ok(state.task.totalElapsedSec >= state.task.elapsedSec);
    assert.equal(state.timeline.length, version);
    for (const release of state.releases) {
      assert.match(
        await (await fetch(c.origin + release.previewUrl)).text(),
        new RegExp('continuation v' + release.version),
      );
      assert.equal((await fetch(c.origin + release.downloadUrl)).status, 200);
    }
    if (version > 1) {
      const response = await fetch(c.origin + state.controlBase + '/api/feedback', {
        method: 'POST',
        headers: {
          Origin: c.origin,
          'Content-Type': 'application/json',
          'X-CD-Token': state.csrfToken,
        },
        body: JSON.stringify({
          session_id: state.task.id,
          id: 'review-old-version-' + version,
          text: 'Keep the V1 interaction',
          version: 1,
        }),
      });
      assert.equal(response.status, 200);
      await until(
        () =>
          fs.existsSync(path.join(workspace.path, 'received-feedback.txt')) &&
          fs
            .readFileSync(path.join(workspace.path, 'received-feedback.txt'), 'utf8')
            .includes('Keep the V1 interaction'),
      );
    }
    assert.equal(state.task.awaitingPlanApproval, false);
    assert.equal(state.task.planMode, 'rolling');
    fs.writeFileSync(path.join(workspace.path, '.finish-fixture'), 'done');
    await until(async () => {
      const s = await c.state(run.runId);
      return s.task.status === 'done' && !s.workbench.workspaces[0].busy;
    });
    if (version === 1) {
      firstFile = path.join(workspace.path, '.live-delivery', state.task.id, 'release.json');
      original = fs.readFileSync(firstFile, 'utf8');
    } else assert.equal(fs.readFileSync(firstFile, 'utf8'), original);
    parentRunId = run.runId;
    if (version === 2) {
      await host.close();
      c = client(await start());
    }
  }
  const independent = await (
    await c.post('tasks', {
      id: 'independent-same-workspace',
      workspaceId: workspace.id,
      query: 'A separate objective',
      timeBudgetSec: 300,
    })
  ).json();
  const fresh = await until(async () => {
    const state = await c.state(independent.runId);
    return state.releases?.length ? state : null;
  });
  assert.notEqual(independent.taskId, taskId);
  assert.equal(fresh.workbench.runs.length, 2);
  assert.deepEqual(
    fresh.releases.map((r) => r.version),
    [1],
  );
  assert.equal(fresh.messages[0].text, 'A separate objective');
});

test('workbench public output masks configured secrets before bounding text', async (t) => {
  const secret = 'fixture-custom-credential-should-not-reach-browser';
  const fixture = await setup(t, { TEST_API_KEY: secret }),
    c = client(fixture.host);
  const w = await (await c.post('workspaces', { name: 'public-output' })).json();
  const started = await (
    await c.post('tasks', {
      id: 'public-output-request',
      workspaceId: w.workspace.id,
      query: 'Build',
      timeBudgetSec: 600,
    })
  ).json();
  await until(async () => (await c.state(started.runId)).releases?.length);
  fs.appendFileSync(
    path.join(fixture.options.stateDir, 'runs', started.runId, 'trajectory.jsonl'),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'public-1', type: 'agent_message', text: 'Result ' + secret + 'x'.repeat(15990) },
    }) + '\n',
  );
  const state = await c.state(started.runId);
  assert.equal(state.agentOutput.length, 1);
  assert.ok(state.agentOutput[0].text.length <= 16000);
  assert.doesNotMatch(state.agentOutput[0].text, /fixture-custom|reach-browser/);
});

test('the host refreshes child dashboard links across restart without restarting the child', async (t) => {
  const fixture = await setup(t),
    firstClient = client(fixture.host);
  const workspace = await (await firstClient.post('workspaces', { name: 'entry-link' })).json();
  const started = await (
    await firstClient.post('tasks', {
      id: 'entry-link-request',
      workspaceId: workspace.workspace.id,
      query: 'Build a preview',
      timeBudgetSec: 600,
    })
  ).json();
  const registryFile = path.join(fixture.options.stateDir, 'registry.json');
  const before = await until(() => {
    const run = JSON.parse(fs.readFileSync(registryFile, 'utf8')).runs.find(
      (r) => r.id === started.runId,
    );
    return run?.pid && run.status === 'running' ? run : null;
  });
  const file = path.join(fixture.options.stateDir, 'runs', before.id, 'dashboard.json');
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(new URL(old.urls[0]).port, String(fixture.host.server.address().port));
  assert.equal(new URL(old.urls[0]).searchParams.get('run'), before.id);
  assert.equal(new URL(old.urls[0]).searchParams.get('s'), before.sessionId);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
  await fixture.host.close();
  const restarted = await fixture.start();
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.notDeepEqual(current.urls, old.urls);
  assert.equal(new URL(current.urls[0]).port, String(restarted.server.address().port));
  assert.equal(new URL(current.urls[0]).hash, '#access=' + restarted.access.token);
  const after = JSON.parse(fs.readFileSync(registryFile, 'utf8')).runs.find(
    (r) => r.id === before.id,
  );
  assert.equal(after.pid, before.pid);
  assert.equal(after.pidStart, before.pidStart);
  assert.equal(after.status, 'running');
});

test('imported CLI continuations retain more than eight executions in one task', async (t) => {
  const { host, options } = await setup(t),
    c = client(host);
  const dir = path.join(options.workspaceRoot, 'cli-history');
  fs.mkdirSync(dir);
  const cfg = {
    workspaceDir: dir,
    harness: 'codex',
    sessionKey: 'codex:imported',
    instance: 'imported',
    port: 0,
    basePath: '/live-delivery',
    timeBudgetSec: 300,
    deliverEverySec: 60,
    minWorkingSec: 0,
    minReleases: 1,
  };
  for (let i = 1; i <= 10; i++) {
    assert.ok(beginCd(cfg, `Request ${i}`).ok);
    fs.writeFileSync(path.join(dir, 'index.html'), `<h1>Version ${i}</h1>`);
    assert.ok(publishVersion(cfg, { paths: ['index.html'], preview_entry: 'index.html' }).ok);
    assert.ok(markDone(cfg, `Delivered ${i}`).ok);
  }
  const { workspace } = await (await c.post('workspaces', { name: 'cli-history' })).json();
  const task = host.catalog().runs.find((r) => r.workspaceId === workspace.id);
  assert.equal(host.catalog().runs.filter((r) => r.workspaceId === workspace.id).length, 1);
  const state = await c.state(task.id);
  assert.deepEqual(
    state.releases.map((r) => r.version),
    Array.from({ length: 10 }, (_, i) => i + 1),
  );
  assert.equal(state.messages[0].text, 'Request 1');
  assert.equal(state.task.nextVersion, 11);
  assert.match(await (await fetch(c.origin + state.releases[0].previewUrl)).text(), /Version 1/);
});

test('stop during feedback interruption confirms exit and preserves the delivered version', async (t) => {
  const { host } = await setup(t),
    c = client(host);
  const { workspace } = await (await c.post('workspaces', { name: 'stop-handoff' })).json();
  const run = await (
    await c.post('tasks', {
      id: 'stop-during-handoff',
      workspaceId: workspace.id,
      query: 'Build [WAIT-INTERRUPT]',
      timeBudgetSec: 300,
    })
  ).json();
  const before = await until(async () => {
    const state = await c.state(run.runId);
    return state.releases?.length ? state : null;
  });
  const control = async (action, payload = {}) =>
    fetch(c.origin + before.controlBase + '/api/' + action, {
      method: 'POST',
      headers: {
        Origin: c.origin,
        'Content-Type': 'application/json',
        'X-CD-Token': before.csrfToken,
      },
      body: JSON.stringify({ session_id: before.task.id, ...payload }),
    });
  assert.equal(
    (await control('feedback', { id: 'interrupt-then-stop', text: 'Add a control' })).status,
    200,
  );
  await until(() => fs.existsSync(path.join(workspace.path, '.interrupting-fixture')));
  assert.equal((await control('wrap-up')).status, 200);
  const stopped = await until(async () => {
    const state = await c.state(run.runId);
    return state.task.stopRequest?.confirmedTs && !state.workbench.workspaces[0].busy
      ? state
      : null;
  });
  assert.equal(stopped.task.status, 'paused');
  assert.equal(stopped.workbench.execution.status, 'finished');
  assert.equal(stopped.releases[0].digest, before.releases[0].digest);
});
