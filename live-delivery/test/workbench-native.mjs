// Real Codex child, deterministic local model service, no user credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parse } from 'smol-toml';
import { createCodexWorkbench } from '../.test-build/dashboard.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-web-native-'));
const home = path.join(temp, 'source-home');
fs.mkdirSync(home);
const rolling = true;
const interruptFeedback = process.env.QWEN_LD_TEST_FEEDBACK === '1';
const fixtureKey = randomUUID();
let interruptedResponseClosed = false;
const steps = [
  [
    'ld_begin',
    {
      task: 'Native browser task',
      milestones: [
        {
          id: 'usable',
          title: 'Working page',
          scope: 'Complete offline page',
          acceptance: ['Opens'],
          target_after: '1m',
        },
      ],
    },
  ],
  ['ld_status', { activity: '正在检查页面入口' }],
  [
    'ld_begin',
    {
      task: 'Native browser task',
      plan_revision: 1,
      estimates: [
        { id: 'usable', estimated_after: '75s', reason: 'Allow time for offline checks' },
      ],
    },
  ],
  [
    'ld_publish',
    {
      paths: ['output'],
      preview_entry: 'output/index.html',
      milestone_id: 'usable',
      checks: [{ label: 'Opens', result: 'passed' }],
    },
  ],
  ...(rolling
    ? [
        ['ld_done', { summary: 'Premature finish must be rejected' }],
        [
          'ld_begin',
          {
            task: 'Native browser task',
            next_milestone: {
              id: 'improved',
              title: 'New interaction',
              scope: 'Add a usable comparison',
              acceptance: ['Opens'],
              target_after: '90s',
            },
            plan_revision: 2,
          },
        ],
        [
          'ld_publish',
          {
            paths: ['output'],
            preview_entry: 'output/index.html',
            milestone_id: 'improved',
            checks: [{ label: 'Opens', result: 'passed' }],
          },
        ],
      ]
    : []),
  ['ld_status', {}],
  ['ld_done', { summary: 'Complete' }],
  [null, 'Complete.'],
];
if (interruptFeedback) {
  steps.splice(
    7,
    0,
    [
      'ld_begin',
      {
        task: 'Native browser task',
        plan_revision: 3,
        revise_milestone: {
          id: 'improved',
          title: 'Tablet design',
          scope: 'Design a tablet instead of a laptop',
          acceptance: ['Tablet layout'],
          target_after: '110s',
          reason: 'Changed from the new user message',
          feedback_ids: ['native-tablet-feedback'],
        },
      },
    ],
    [
      'ld_publish',
      {
        paths: ['output'],
        preview_entry: 'output/index.html',
        milestone_id: 'improved',
        plan_revision: 4,
        note: 'Delivered the tablet layout',
        feedback_ids: ['native-tablet-feedback'],
        checks: [{ label: 'Tablet layout', result: 'passed' }],
      },
    ],
  );
}
let requests = 0,
  modelError;
let sawParentEntry = false;
let continuePublication, finishAfterUserStop;
let artifactDir;
const stopGate = new Promise((resolve) => {
  finishAfterUserStop = resolve;
});
const publicationGate = new Promise((resolve) => {
  continuePublication = resolve;
});
const model = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (!req.url.includes('responses')) {
      res.end('{}');
      return;
    }
    const input = JSON.parse(body);
    if (interruptFeedback) assert.equal(req.headers.authorization, 'Bearer ' + fixtureKey);
    const entryLinks = JSON.stringify(input.input).match(
      /http:\/\/(?:127\.0\.0\.1|localhost):\d+\/live-delivery\/\?[^"\\\s]+/g,
    );
    for (const link of entryLinks ?? []) {
      const entry = new URL(link);
      assert.equal(
        entry.port,
        String(host.server.address().port),
        'Model must receive parent port',
      );
      assert.ok(entry.searchParams.get('run'), 'Parent entry must select the browser run');
      assert.ok(entry.searchParams.get('s'), 'Parent entry must select the delivery session');
      sawParentEntry = true;
    }
    const tools = (input.tools ?? []).flatMap((tool) =>
      tool.type === 'namespace'
        ? tool.tools.map((child) => ({ ...child, namespace: tool.name }))
        : [tool],
    );
    const [method, args] = steps[requests++] ?? [];
    assert.ok(requests <= steps.length, 'Unexpected model request');
    if (interruptFeedback && requests === 7) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': waiting for user interruption\n\n');
      res.on('close', () => {
        interruptedResponseClosed = true;
      });
      return; // Deliberately no tool boundary; only a real interrupt can release it.
    }
    if (interruptFeedback && requests === 8) {
      assert.ok(JSON.stringify(input.input).includes('native-tablet-feedback'));
      assert.ok(JSON.stringify(input.input).includes('tablet instead of a laptop'));
    }
    if (method === 'ld_publish') await publicationGate;
    if (rolling && method === 'ld_publish' && args.milestone_id === 'improved')
      fs.writeFileSync(
        path.join(artifactDir, 'index.html'),
        '<h1>Native verified delivery with comparison</h1>',
      );
    if (rolling && method === 'ld_done' && args.summary === 'Complete') await stopGate;
    const tool = method ? tools.find((t) => t.name.endsWith(method)) : null;
    if (method) assert.ok(tool, 'Plugin tool must load');
    const item = method
      ? {
          type: 'function_call',
          id: `fc_${requests}`,
          call_id: `call_${requests}`,
          name: tool.name,
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
          arguments: JSON.stringify(args),
          status: 'completed',
        }
      : {
          type: 'message',
          id: `msg_${requests}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: args, annotations: [] }],
        };
    const response = {
      id: `resp_${requests}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: input.model,
      status: 'completed',
      output: [item],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sequence_number = 0;
    const event = (type, data) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence_number++, ...data })}\n\n`,
      );
    event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    event('response.output_item.added', {
      output_index: 0,
      item: method
        ? { ...item, arguments: '', status: 'in_progress' }
        : { ...item, content: [], status: 'in_progress' },
    });
    if (method) {
      event('response.function_call_arguments.delta', {
        item_id: item.id,
        output_index: 0,
        delta: item.arguments,
      });
      event('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: 0,
        arguments: item.arguments,
      });
    } else {
      event('response.content_part.added', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      event('response.output_text.delta', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: args,
      });
      event('response.output_text.done', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: args,
      });
      event('response.content_part.done', {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
      });
    }
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response });
    res.end();
  } catch (error) {
    modelError = error;
    res.writeHead(500);
    res.end('{}');
  }
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
fs.writeFileSync(
  path.join(home, 'config.toml'),
  `model="fixture-model"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:${model.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n${interruptFeedback ? 'env_key="fixture_lowercase_key"\n' : ''}`,
);
let host = createCodexWorkbench(
  {
    planMode: rolling ? 'rolling' : 'fixed',
    stateDir: path.join(temp, 'private'),
    workspaceRoot: path.join(temp, 'workspaces'),
    pluginRoot: process.env.QWEN_LD_TEST_PACKAGE
      ? path.resolve(process.env.QWEN_LD_TEST_PACKAGE)
      : root,
    codexHome: home,
    codexBin: process.env.CODEX_BIN || 'codex',
  },
  {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    ...(interruptFeedback ? { fixture_lowercase_key: fixtureKey } : {}),
  },
);
await new Promise((r) => host.server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${host.server.address().port}`,
  base = origin + '/live-delivery';
const headers = {
  Origin: origin,
  Authorization: 'Bearer ' + host.access.token,
  'Content-Type': 'application/json',
  'X-CD-Token': host.token,
  // The restart fixture must not reuse a socket from the retired listener.
  ...(interruptFeedback ? { Connection: 'close' } : {}),
};
const post = (route, data) =>
  fetch(base + route, { method: 'POST', headers, body: JSON.stringify(data) });
async function until(read) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (modelError) throw modelError;
    const result = await read();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Native task timed out');
}
try {
  const created = await (await post('/api/workspaces', { name: 'native-case' })).json();
  artifactDir = path.join(created.workspace.path, 'output');
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(
    path.join(created.workspace.path, 'output/index.html'),
    '<h1>Native verified delivery</h1>',
  );
  const started = await (
    await post('/api/tasks', {
      id: 'native-security-fixture',
      workspaceId: created.workspace.id,
      query: 'Deliver the prepared page',
      timeBudgetSec: 120,
    })
  ).json();
  const read = async () => {
    const state = await (await fetch(base + '/api/state?run=' + started.runId, { headers })).json();
    assert.notEqual(
      state.workbench?.execution?.status,
      'failed',
      state.workbench?.execution?.error,
    );
    return state;
  };
  await until(async () => (await read()).task?.activity?.text === '正在检查页面入口');
  continuePublication();
  let beforeFeedback;
  if (interruptFeedback) {
    beforeFeedback = await until(async () => {
      const s = await read();
      return requests === 7 && s.releases?.length === 1 && s.plan.length === 2 ? s : null;
    });
    // Reload only the web host, then interrupt the still-running native process.
    const port = host.server.address().port,
      options = host.options;
    await host.close();
    host = createCodexWorkbench(options, {
      PATH: process.env.PATH,
      HOME: os.homedir(),
      fixture_lowercase_key: fixtureKey,
    });
    await new Promise((r) => host.server.listen(port, '127.0.0.1', r));
    headers.Authorization = 'Bearer ' + host.access.token;
    headers['X-CD-Token'] = host.token;
    const sentAt = Date.now();
    const response = await fetch(origin + beforeFeedback.controlBase + '/api/feedback', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session_id: beforeFeedback.task.id,
        id: 'native-tablet-feedback',
        text: 'Make V2 a tablet instead of a laptop.',
      }),
    });
    assert.equal(response.status, 200);
    await until(
      async () =>
        (await read()).feedback.find((f) => f.id === 'native-tablet-feedback')?.status !== 'queued',
    );
    assert.ok(Date.now() - sentAt < 20000, 'Message must not wait for a tool boundary');
    assert.ok(interruptedResponseClosed, 'The in-flight model response must be cancelled');
  }
  if (rolling) {
    const next = await until(async () => {
      const s = await read();
      return s.releases?.length === 2 ? s : null;
    });
    assert.equal(next.task.status, 'delivered');
    assert.equal(next.task.awaitingPlanApproval, false);
    assert.equal(next.task.awaitingNextPlan, true);
    const stopped = await fetch(origin + next.controlBase + '/api/wrap-up', {
      method: 'POST',
      headers,
      body: JSON.stringify({ session_id: next.task.id }),
    });
    assert.equal(stopped.status, 200);
    finishAfterUserStop();
  }
  const done = await until(async () => {
    const state = await read();
    return state.task?.status === 'done' && state.workbench.execution.status === 'finished'
      ? state
      : null;
  });
  assert.equal(done.releases.length, rolling ? 2 : 1);
  if (interruptFeedback) {
    assert.equal(done.task.id, beforeFeedback.task.id);
    assert.equal(done.task.startedTs, beforeFeedback.task.startedTs);
    assert.equal(done.task.timeBudgetSec, beforeFeedback.task.timeBudgetSec);
    assert.equal(done.releases[0].digest, beforeFeedback.releases[0].digest);
    assert.equal(done.plan[1].title, 'Tablet design');
    assert.deepEqual(done.releases[1].feedbackIds, ['native-tablet-feedback']);
    assert.equal(done.feedback[0].hookEvent, 'UserPromptSubmit');
    const events = fs
      .readFileSync(
        path.join(host.options.stateDir, 'runs', started.runId, 'trajectory.jsonl'),
        'utf8',
      )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const threads = events.filter((e) => e.type === 'thread.started').map((e) => e.thread_id);
    assert.equal(threads.length, 2);
    assert.equal(new Set(threads).size, 1, 'Resume the same native Codex thread');
  }
  assert.equal(done.task.activity, null);
  assert.ok(
    done.executionEvents.some((e) => e.tool.endsWith('ld_publish') && e.status === 'completed'),
    JSON.stringify(done.executionEvents),
  );
  assert.equal(requests, steps.length);
  assert.equal(sawParentEntry, true, 'Native model must receive a usable parent workbench link');
  const config = parse(
    fs.readFileSync(
      path.join(host.options.stateDir, 'runs', started.runId, 'codex-home/config.toml'),
      'utf8',
    ),
  );
  const trust = Object.entries(config.hooks.state);
  assert.equal(trust.length, 6);
  for (const [key, value] of trust) {
    assert.ok(key.startsWith('ld@live-delivery-local:'));
    assert.equal(value.enabled, true);
    assert.match(value.trusted_hash, /^sha256:/);
  }
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.match(
    await (await fetch(origin + done.releases[0].previewUrl)).text(),
    /Native verified delivery/,
  );
  if (interruptFeedback)
    console.log(
      'PASS: interrupted a real in-flight Codex response, resumed the same thread, received user feedback at turn start, revised V2 and preserved V1, budget and session.',
    );
  console.log(
    'PASS: authenticated browser task, real Codex child with six exact trusted hooks, automatic first plan, live work update, publication and completion; no trust bypass or model credentials.',
  );
} catch (error) {
  console.error(`Private fixture diagnostics: ${temp}`);
  throw error;
} finally {
  continuePublication();
  finishAfterUserStop();
  await host.close();
  model.closeAllConnections();
  model.close();
  // Keep failed diagnostics private; successful runs have no surviving children.
  if (!modelError && requests === steps.length)
    await fs.promises.rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
}
