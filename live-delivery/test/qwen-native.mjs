import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'ld-qwen-'));
const cwd = path.join(scratch, 'workspace');
mkdirSync(cwd);
const qwen = process.env.QWEN_BIN || 'qwen';
const { chromium, expect } = await import(process.env.PLAYWRIGHT_TEST_MODULE || 'playwright/test');
const env = {
  PATH: process.env.PATH,
  HOME: scratch,
  TMPDIR: scratch,
  QWEN_HOME: path.join(scratch, 'qwen-home'),
  QWEN_RUNTIME_DIR: path.join(scratch, 'qwen-runtime'),
  QWEN_DISABLE_AUTO_TITLE: '1',
  CI: '1',
  QWEN_LD_OPEN_BROWSER: 'never',
  OPENAI_API_KEY: 'local-fixture-key',
};
const runs = ['alpha', 'bravo'].map((name) => ({ name, stage: 0, output: '' }));
const children = [];
let browser;
const failure = Promise.withResolvers();
const cancel = new AbortController();
const stop = setTimeout(() => failure.reject(new Error('Qwen smoke test timed out')), 90000);
const acceptance = 'The preview contains the expected heading';
const milestone = (version) => ({
  id: `version-${version}`,
  title: `Preview V${version}`,
  scope: 'Show this session’s heading',
  acceptance: [acceptance],
  target_after: version === 1 ? '45s' : '100s',
});

async function state(run, query = '') {
  const url = new URL(run.url);
  const token = new URLSearchParams(url.hash.slice(1)).get('access');
  return fetch(new URL('/live-delivery/api/state' + query, url), {
    headers: { Authorization: 'Bearer ' + token },
    signal: cancel.signal,
  });
}

function act(run, body, response) {
  const messages = JSON.stringify(body.messages);
  const stage = run.stage++;
  const tool = (suffix, args) => {
    const name = body.tools?.find(
      (entry) => entry.function.name === suffix || entry.function.name.endsWith('__' + suffix),
    )?.function.name;
    assert.ok(name, `CLI did not advertise ${suffix}`);
    return {
      index: 0,
      id: `call_${stage}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    };
  };
  const file = (version) => `${run.name}-v${version}.html`;
  const write = (version, heading) =>
    tool('write_file', {
      file_path: path.join(cwd, file(version)),
      content: `<h1>${heading}</h1>`,
    });
  const publish = (version, feedback_ids) =>
    tool('ld_publish', {
      paths: [file(version)],
      preview_entry: file(version),
      milestone_id: milestone(version).id,
      checks: [{ label: acceptance, result: 'passed' }],
      feedback_ids,
    });
  let call;
  let content;
  switch (stage) {
    case 0:
      assert.match(
        messages,
        /Use the installed ld:go skill/,
        'UserPromptSubmit did not enrich the CLI request',
      );
      call = tool('ld_begin', { task: run.task, milestones: [milestone(1)] });
      break;
    case 1:
      run.url = messages.match(
        /http:\/\/127\.0\.0\.1:\d+\/live-delivery\/\?s=[\w.-]+#access=[a-f0-9]+/,
      )?.[0];
      assert.ok(run.url, 'No workbench link in the MCP result');
      call = write(1, `${run.name} V1`);
      break;
    case 2:
      call = publish(1);
      break;
    case 3:
      run.afterV1 = () => send(tool('ld_status', {}));
      return;
    case 4: {
      const feedback = `Use the heading ${run.name}-updated`;
      assert.ok(
        messages.includes(feedback),
        `Missing browser feedback in ${run.name} model context`,
      );
      const other = runs.find((candidate) => candidate !== run);
      assert.ok(
        !messages.includes(`Use the heading ${other.name}-updated`),
        'Feedback crossed CLI sessions',
      );
      const injected = body.messages
        .flatMap((message) =>
          typeof message.content === 'string'
            ? [message.content]
            : (message.content ?? []).map((part) => part.text ?? ''),
        )
        .find((message) => message.includes(feedback));
      run.feedbackId = injected?.match(/"id":"([^"]+)","version":1,"text":"Use the heading/)?.[1];
      assert.ok(run.feedbackId, 'Feedback ID not present in the hook context');
      call = tool('ld_begin', {
        task: run.task,
        next_milestone: milestone(2),
        plan_revision: run.planRevision,
      });
      break;
    }
    case 5:
      call = write(2, `${run.name}-updated`);
      break;
    case 6:
      call = publish(2, [run.feedbackId]);
      break;
    case 7:
      run.afterV2 = () => send(tool('ld_done', { summary: 'Browser verified both versions' }));
      return;
    case 8:
      content = `Delivered V1 and V2: ${run.url}`;
      break;
    default:
      throw new Error(
        `Unexpected model request ${stage} for ${run.name}: ${body.tools?.map((entry) => entry.function.name).join(', ')}`,
      );
  }
  send(call, content);

  function send(action, finalText) {
    const chunk = (delta, finish_reason = null) => ({
      id: `completion-${run.name}-${stage}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'ld-fixture',
      choices: [{ index: 0, delta, finish_reason }],
    });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = action
      ? { role: 'assistant', tool_calls: [action] }
      : { role: 'assistant', content: finalText };
    response.end(
      [chunk(delta), chunk({}, action ? 'tool_calls' : 'stop')]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join('') + 'data: [DONE]\n\n',
    );
  }
}

const fixture = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    const prompt = JSON.stringify(body.messages);
    const run = runs.find(({ name }) => prompt.includes(`LD-NATIVE-${name}`));
    assert.ok(run, 'Missing session marker in provider request');
    act(run, body, response);
  } catch (error) {
    failure.reject(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

async function waitFor(predicate) {
  while (!(await predicate())) {
    cancel.signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function checkBrowser(run) {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('/live-delivery:simple-tour', 'off'));
  await page.goto(run.url);
  const frame = page.frameLocator('#artifact');
  const heading = frame.locator('h1');
  await expect(heading).toHaveText(`${run.name} V1`);
  await expect(page.locator('#new-task-button')).toBeHidden();
  const feedback = `Use the heading ${run.name}-updated`;
  await page.locator('#feedback').fill(feedback);
  await page.locator('#feedback').press('Enter');
  await waitFor(async () => {
    const view = await (await state(run)).json();
    return view.feedback?.some(({ text }) => text === feedback);
  });
  run.afterV1();

  await page.locator('#versions [data-version="2"]').click();
  await expect(heading).toHaveText(`${run.name}-updated`);
  await page.locator('#versions [data-version="1"]').click();
  await expect(heading).toHaveText(`${run.name} V1`);
  const other = runs.find((candidate) => candidate !== run);
  await expect(page.locator('#feed')).toContainText(feedback);
  await expect(page.locator('#feed')).not.toContainText(`Use the heading ${other.name}-updated`);
  await page.locator('#stop-button').click();
  await waitFor(async () => {
    const view = await (await state(run)).json();
    return !!view.task?.stopRequest;
  });
}

async function exercise() {
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  env.OPENAI_BASE_URL = `http://127.0.0.1:${fixture.address().port}/v1`;
  mkdirSync(env.QWEN_HOME);
  writeFileSync(
    path.join(env.QWEN_HOME, 'settings.json'),
    JSON.stringify({
      general: { enableAutoUpdate: false },
      memory: {
        enableManagedAutoMemory: false,
        enableManagedAutoDream: false,
        enableAutoSkill: false,
      },
      telemetry: { enabled: false },
    }),
  );
  const link = spawnSync(qwen, ['extensions', 'link', root], {
    cwd,
    env,
    input: 'y\n',
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(link.status, 0, link.error?.message || link.stderr);
  for (const run of runs) {
    run.task = `LD-NATIVE-${run.name}: build a versioned HTML preview`;
    const proc = spawn(
      qwen,
      [
        '--auth-type',
        'openai',
        '--model',
        'ld-fixture',
        '--approval-mode',
        'auto-edit',
        '--allowed-tools',
        ...['begin', 'status', 'publish', 'done'].map((name) => 'mcp__live-delivery__ld_' + name),
        '--advisor',
        'off',
        '--output-format',
        'stream-json',
        '-p',
        '$ld:go ' + run.task,
      ],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(proc, 'close');
    children.push({ proc, exited });
    proc.stdout.on('data', (chunk) => {
      run.output += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      run.output += chunk;
    });
    run.finished = exited.then(([code]) => {
      assert.equal(code, 0, `Qwen ${run.name} exited with ${code}`);
      assert.equal(run.stage, 9, `Qwen ${run.name} stopped before completing the test`);
    });
    run.finished.catch(failure.reject);
  }
  await waitFor(() => runs.every((run) => run.afterV1));
  const views = await Promise.all(runs.map(async (run) => (await state(run)).json()));
  for (const [index, run] of runs.entries()) {
    assert.equal(views[index].task.request, run.task);
    assert.deepEqual(
      views[index].releases.map(({ version }) => version),
      [1],
    );
    run.planRevision = views[index].planReview.revision;
    const foreignId = views[1 - index].task.id;
    assert.equal((await state(run, '?s=' + encodeURIComponent(foreignId))).status, 404);
  }
  assert.notEqual(new URL(runs[0].url).origin, new URL(runs[1].url).origin);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  await Promise.all(runs.map(checkBrowser));
  await waitFor(() => runs.every((run) => run.afterV2));
  for (const run of runs) run.afterV2();
  await Promise.all(runs.map((run) => run.finished));
  for (const run of runs) {
    const id = new URL(run.url).searchParams.get('s');
    const released = JSON.parse(
      readFileSync(path.join(cwd, '.live-delivery', id, 'release.json'), 'utf8'),
    );
    assert.equal(released.status, 'done');
    assert.equal(released.feedback.find(({ id }) => id === run.feedbackId)?.status, 'addressed');
  }
  console.log(
    'PASS: two real Qwen CLI processes in one workspace, isolated browser feedback and frozen V1/V2 previews.',
  );
}

try {
  await Promise.race([exercise(), failure.promise]);
} catch (error) {
  for (const run of runs) {
    const redacted = run.output.replace(/#access=[a-f0-9]+/g, '#access=[redacted]');
    if (redacted) console.error(`${run.name}: ${redacted.slice(-3500)}`);
  }
  throw error;
} finally {
  cancel.abort();
  clearTimeout(stop);
  for (const { proc } of children) if (proc.exitCode === null) proc.kill();
  await browser?.close();
  fixture.closeAllConnections();
  fixture.close();
  await Promise.allSettled(children.map(({ exited }) => exited));
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
