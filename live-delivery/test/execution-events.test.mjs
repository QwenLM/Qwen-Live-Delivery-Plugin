import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexExecutionEvent as executionEvent, readExecutionTrace } from '../.test-build/trace.js';
import { hookExecutionEvent } from '../.test-build/hook-activity.js';
import { beginCd, currentState } from '../.test-build/core.js';
import { recordHostEvent } from '../.test-build/controls.js';
test('execution summaries expose tool metadata and workspace paths, not arguments, output or reasoning', () => {
  const cwd = '/workspace/project';
  const event = executionEvent(
    {
      type: 'item.started',
      item: {
        id: '1',
        type: 'command_execution',
        command: 'TOKEN=do-not-show npm run build --secret private-value',
        aggregated_output: 'PRIVATE_OUTPUT',
      },
    },
    cwd,
    100,
  );
  assert.equal(event.detail, 'npm run build');
  assert.equal(event.status, 'running');
  assert.doesNotMatch(JSON.stringify(event), /TOKEN|do-not-show|private-value|PRIVATE_OUTPUT/);
  const files = executionEvent(
    {
      type: 'item.completed',
      item: {
        id: '2',
        type: 'file_change',
        changes: [{ path: 'src/app.ts' }, { path: '.env' }, { path: '/elsewhere/private.txt' }],
      },
    },
    cwd,
    101,
  );
  assert.deepEqual(files.files, ['src/app.ts']);
  assert.equal(
    executionEvent(
      { type: 'item.completed', item: { id: '3', type: 'reasoning', text: 'private reasoning' } },
      cwd,
      102,
    ),
    null,
  );
  assert.equal(
    executionEvent(
      { type: 'item.completed', item: { id: '4', type: 'agent_message', text: 'unfiltered text' } },
      cwd,
      103,
    ),
    null,
  );
});
test('trajectory tail merges status by ID, ignores partial lines and stays bounded', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'trajectory.jsonl');
  const record = (id, type, extra = {}) =>
    JSON.stringify({ type, item: { id, type: 'mcp_tool_call', tool: 'ld_status', ...extra } });
  fs.writeFileSync(file, record('one', 'item.started') + '\n');
  assert.equal(readExecutionTrace(file, dir, 100).events[0].status, 'running');
  fs.appendFileSync(file, record('one', 'item.completed'));
  assert.equal(readExecutionTrace(file, dir, 101).events[0].status, 'running');
  fs.appendFileSync(file, '\n');
  assert.deepEqual(readExecutionTrace(file, dir, 102).events[0], {
    id: 'one',
    tool: 'ld_status',
    kind: 'tool',
    status: 'completed',
    ts: 100,
    order: 0,
  });
  for (let i = 0; i < 100; i++)
    fs.appendFileSync(file, record('tool-' + i, 'item.completed') + '\n');
  const events = readExecutionTrace(file, dir, 103).events;
  assert.equal(events.length, 80);
  assert.equal(events.at(-1).id, 'tool-99');
  fs.writeFileSync(file, 'malformed\n' + record('new', 'item.started') + '\n');
  assert.equal(readExecutionTrace(file, dir, 104).events[0].id, 'new');
});
test('CLI PostToolUse records public metadata and keeps only recent events', (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-hook-events-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const cfg = {
    workspaceDir,
    harness: 'codex',
    sessionKey: 'codex:test',
    instance: 'test',
    port: 0,
    basePath: '/live-delivery',
    timeBudgetSec: 600,
    deliverEverySec: 60,
    minWorkingSec: 0,
    minReleases: 1,
  };
  beginCd(cfg, 'Build');
  for (let i = 0; i < 85; i++) {
    const now = 1000 + i;
    const execution = hookExecutionEvent(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'read_file',
        tool_use_id: 'call-' + i,
        tool_input: { file_path: 'src/main.ts', secret: 'PRIVATE' },
        tool_response: 'PRIVATE_OUTPUT',
      },
      cfg.workspaceDir,
      now,
    );
    recordHostEvent(cfg, { name: 'PostToolUse', execution }, now);
  }
  const events = currentState(cfg).executionEvents;
  assert.equal(events.length, 80);
  assert.deepEqual(events.at(-1).files, ['src/main.ts']);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test('public Agent updates merge by ID, preserve order, redact tokens and exclude reasoning', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-public-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'trajectory.jsonl');
  const emit = (type, item) => fs.appendFileSync(file, JSON.stringify({ type, item }) + '\n');
  emit('item.started', { id: 'answer', type: 'agent_message', text: 'Starting' });
  emit('item.started', { id: 'cmd', type: 'command_execution', command: 'node secret.js' });
  let trace = readExecutionTrace(file, dir, 100);
  assert.equal(trace.output[0].status, 'streaming');
  assert.ok(trace.output[0].order < trace.events[0].order);
  emit('item.updated', { id: 'answer', type: 'agent_message', text: 'Starting the first design' });
  emit('item.completed', { id: 'private', type: 'reasoning', text: 'PRIVATE_REASONING' });
  trace = readExecutionTrace(file, dir, 200);
  assert.equal(trace.output.length, 1);
  assert.equal(trace.output[0].ts, 100);
  assert.equal(trace.output[0].text, 'Starting the first design');
  emit('item.completed', {
    id: 'answer',
    type: 'agent_message',
    text: 'Done https://localhost/#access=private-workbench-token api_key=private-key-value',
  });
  emit('item.completed', {
    id: 'cmd',
    type: 'command_execution',
    exit_code: 1,
    aggregated_output: 'bwrap: Creating new namespace failed: PRIVATE_OUTPUT',
  });
  trace = readExecutionTrace(file, dir, 300);
  assert.equal(trace.output[0].status, 'completed');
  assert.equal(trace.events[0].failure, 'sandbox-unavailable');
  assert.doesNotMatch(
    JSON.stringify(trace),
    /private-workbench-token|private-key-value|PRIVATE_REASONING|PRIVATE_OUTPUT|secret.js/,
  );
  fs.appendFileSync(file, '{"type":"item.updated"');
  assert.equal(readExecutionTrace(file, dir, 400).output.length, 1);
  fs.writeFileSync(
    file,
    Array.from({ length: 55 }, (_, i) =>
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'msg-' + i, type: 'agent_message', text: 'Public ' + i },
      }),
    ).join('\n') + '\n',
  );
  trace = readExecutionTrace(file, dir, 500);
  assert.equal(trace.output.length, 40);
  assert.equal(trace.output.at(-1).id, 'msg-54');
});

test('resumed CLI item IDs preserve earlier records and end interrupted activity', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-resume-trace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'trace.jsonl');
  const records = [
    { type: 'thread.started', thread_id: 'same-thread' },
    {
      type: 'item.started',
      item: { id: 'item_0', type: 'command_execution', command: 'node build.js' },
    },
    { type: 'thread.started', thread_id: 'same-thread' },
    {
      type: 'item.started',
      item: { id: 'item_0', type: 'command_execution', command: 'node check.js' },
    },
    {
      type: 'item.completed',
      item: { id: 'item_0', type: 'command_execution', command: 'node check.js', exit_code: 0 },
    },
  ];
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const { events } = readExecutionTrace(file, dir);
  assert.equal(events.length, 2);
  assert.notEqual(events[0].id, events[1].id);
  assert.equal(events[0].status, 'interrupted');
  assert.equal(events[1].status, 'completed');
});

test('untimestamped public replies retain publication order after a cold trace read', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-trace-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = [
    {
      type: 'item.completed',
      item: { id: 'early', type: 'agent_message', text: 'Building the first version' },
    },
    {
      type: 'item.completed',
      item: {
        id: 'pub1',
        type: 'mcp_tool_call',
        tool: 'ld_publish',
        result: { structured_content: { ok: true, published: { ts: 2000 } } },
      },
    },
    {
      type: 'item.completed',
      item: { id: 'later', type: 'agent_message', text: 'Improving the next version' },
    },
    {
      type: 'item.completed',
      item: {
        id: 'pub2',
        type: 'mcp_tool_call',
        tool: 'ld_publish',
        result: { structured_content: { ok: true, published: { ts: 4000 } } },
      },
    },
    {
      type: 'item.completed',
      timestamp: new Date(5000).toISOString(),
      item: { id: 'dated', type: 'agent_message', text: 'A timestamped reply' },
    },
  ];
  for (const [fileName, now] of [
    ['warm.jsonl', 6000],
    ['cold.jsonl', 12000],
  ]) {
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const { output } = readExecutionTrace(file, dir, now);
    assert.equal(output[0].beforeTs, 2000);
    assert.equal(output[1].beforeTs, 4000);
    assert.equal(output[2].ts, 5000);
    assert.equal(output[2].beforeTs, undefined);
  }
});
