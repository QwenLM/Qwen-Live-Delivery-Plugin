// Claude Code adapter: plugin layout, hook protocol and the session dashboard.
// Offline: drives the built claude-code/dist entry points with fixture inputs.
import { authorize, fetch } from './http-client.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { listStates } from '../.test-build/state.js';
import { readUsage } from '../.test-build/usage.js';

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(pkgRoot);
const claudeRoot = path.join(pkgRoot, 'claude-code');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

function workspace(t) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'ld-claude-'));
  const ws = path.join(temp, 'workspace');
  mkdirSync(ws);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return { temp, ws };
}

const claudeHook = [path.join(claudeRoot, 'dist/hook.mjs'), '--claude-code'];

function hookRunner({ temp, ws }, args = claudeHook) {
  return (event, extra = {}) => {
    const result = spawnSync(process.execPath, args, {
      env: {
        PATH: process.env.PATH,
        HOME: temp,
        TMPDIR: temp,
        CLAUDE_PROJECT_DIR: ws,
        QWEN_LD_INSTANCE_ID: 'claude-fixture-' + path.basename(temp),
        QWEN_LD_PORT: '0',
        QWEN_LD_OPEN_BROWSER: 'never',
      },
      input: JSON.stringify({
        hook_event_name: event,
        session_id: 'abc',
        cwd: ws,
        ...extra,
      }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : {};
  };
}

test('claude-code plugin follows Claude Code plugin conventions and shares the Codex runtime', () => {
  const pkg = json(path.join(pkgRoot, 'package.json'));
  const manifest = json(path.join(claudeRoot, '.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'ld');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.license, pkg.license);

  const marketplace = json(path.join(repoRoot, '.claude-plugin/marketplace.json'));
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.equal(marketplace.plugins[0].source, './live-delivery/claude-code');
  assert.equal(marketplace.plugins[0].version, pkg.version);

  const mcp = json(path.join(claudeRoot, '.mcp.json'));
  assert.deepEqual(mcp.mcpServers['live-delivery'].args, [
    '${CLAUDE_PLUGIN_ROOT}/dist/server.mjs',
    '--claude-code',
  ]);

  // Claude Code has no Interrupt hook event; SessionEnd covers a closed session.
  const hooks = json(path.join(claudeRoot, 'hooks/hooks.json')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), [
    'PostToolUse',
    'SessionEnd',
    'SessionStart',
    'Stop',
    'UserPromptSubmit',
  ]);
  for (const groups of Object.values(hooks))
    for (const group of groups)
      for (const hook of group.hooks)
        assert.equal(hook.command, 'node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" --claude-code');

  assert.equal(
    readFileSync(path.join(claudeRoot, 'skills/go/SKILL.md'), 'utf8'),
    readFileSync(path.join(pkgRoot, 'skills/go/SKILL.md'), 'utf8'),
  );
  assert.equal(
    readFileSync(path.join(claudeRoot, 'LICENSE'), 'utf8'),
    readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8'),
  );
  // One runtime for every harness; --claude-code selects the adapter at run time.
  for (const entry of ['server', 'hook'])
    assert.equal(
      readFileSync(path.join(claudeRoot, 'dist', `${entry}.mjs`), 'utf8'),
      readFileSync(path.join(pkgRoot, 'dist', `${entry}.mjs`), 'utf8'),
    );
});

test('claude-code hook starts a task from /ld:go and binds it to the Claude session', (t) => {
  const dirs = workspace(t);
  const hook = hookRunner(dirs);
  assert.deepEqual(hook('SessionStart', { source: 'startup', model: 'claude-test' }), {});
  // Codex syntax is not a Claude Code command and must not start a task.
  assert.deepEqual(hook('UserPromptSubmit', { prompt: '$ld:go Build the page' }), {});
  assert.equal(listStates(dirs.ws).length, 0);

  const output = hook('UserPromptSubmit', { prompt: '/ld:go Build the requested page' });
  assert.match(output.systemMessage, /DELIVERY DASHBOARD/);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /start producing it immediately/);
  const [state] = listStates(dirs.ws);
  assert.equal(state.task, 'Build the requested page');
  assert.equal(state.harness, 'claude-code');
  assert.equal(state.sessionKey, 'claude-code:abc');
  assert.equal(state.model, 'claude-test');
  // The task text is the first user message; the raw slash command is not recorded.
  assert.deepEqual(
    (state.messages ?? []).filter((m) => m.role === 'user').map((m) => m.text),
    ['Build the requested page'],
  );
});

test('codex hook ignores the Claude Code /ld:go command', (t) => {
  const dirs = workspace(t);
  const hook = hookRunner(dirs, [path.join(pkgRoot, 'dist/hook.mjs')]);
  assert.deepEqual(hook('UserPromptSubmit', { prompt: '/ld:go Build the page' }), {});
  assert.equal(listStates(dirs.ws).length, 0);
});

test('claude-code Stop keeps an unpublished task working and SessionEnd pauses it', (t) => {
  const dirs = workspace(t);
  const hook = hookRunner(dirs);
  hook('SessionStart', { source: 'startup' });
  hook('UserPromptSubmit', { prompt: '/ld:go Write a report' });
  for (const stop_hook_active of [false, true]) {
    const stop = hook('Stop', { stop_hook_active });
    assert.equal(stop.decision, 'block');
    assert.ok(stop.reason);
  }
  assert.deepEqual(hook('SessionEnd', { reason: 'prompt_input_exit' }), {});
  const [state] = listStates(dirs.ws);
  assert.equal(state.status, 'paused');
  assert.equal(state.pauseReason, 'session_end');
});

test('claude-code usage meter reads Claude transcripts once per message id', (t) => {
  const dirs = workspace(t);
  const hook = hookRunner(dirs);
  hook('SessionStart', { source: 'startup' });
  hook('UserPromptSubmit', { prompt: '/ld:go Write a report' });
  const [started] = listStates(dirs.ws);
  const ts = new Date(started.startedTs + 1000).toISOString();
  const before = new Date(started.startedTs - 60000).toISOString();
  const usage = (id, output, timestamp = ts) =>
    JSON.stringify({
      type: 'assistant',
      timestamp,
      message: {
        id,
        usage: {
          input_tokens: 10,
          output_tokens: output,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 5,
        },
      },
    });
  const transcript = path.join(dirs.temp, 'transcript.jsonl');
  writeFileSync(
    transcript,
    [
      usage('msg_before', 999, before), // before the task started: excluded
      usage('msg_1', 3),
      usage('msg_1', 7), // same message, later content block: keep the maximum
      usage('msg_2', 4),
      JSON.stringify({ type: 'user', timestamp: ts }),
    ].join('\n') + '\n',
  );
  hook('Stop', { transcript_path: transcript });
  const meter = readUsage(dirs.ws, started.id);
  assert.equal(meter.input, 20);
  assert.equal(meter.output, 11);
  assert.equal(meter.cacheRead, 200);
  assert.equal(meter.cacheCreate, 10);
});

test(
  'claude-code MCP server serves a loopback session dashboard without browser-created tasks',
  { timeout: 15000 },
  async (t) => {
    const dirs = workspace(t);
    const { temp, ws } = dirs;
    const instance = 'claude-fixture-' + path.basename(temp);
    // Claude Code runs SessionStart before the first tool call binds the session.
    hookRunner(dirs)('SessionStart', { source: 'startup' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(claudeRoot, 'dist/server.mjs'), '--claude-code'],
      cwd: ws,
      env: {
        PATH: process.env.PATH,
        HOME: temp,
        TMPDIR: temp,
        QWEN_LD_WORKSPACE: ws,
        QWEN_LD_INSTANCE_ID: instance,
        QWEN_LD_PORT: '0',
        QWEN_LD_OPEN_BROWSER: 'never',
      },
      stderr: 'pipe',
    });
    let logs = '';
    transport.stderr?.on('data', (c) => (logs += c));
    const client = new Client({ name: 'claude-dashboard-fixture', version: '1' });
    t.after(() => client.close());
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ['ld_begin', 'ld_publish', 'ld_status', 'ld_done'],
    );
    let url;
    for (let i = 0; i < 100 && !url; i++) {
      url = logs.match(/Delivery page: (http:\/\/[^\s]+)/)?.[1];
      if (!url) await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(url, 'Plugin must expose the dashboard before the first task');
    assert.match(logs, /\[live-delivery claude-code\]/);
    const entry = new URL(url);
    assert.equal(entry.hostname, '127.0.0.1', 'Claude Code dashboards bind to loopback only');
    authorize(entry.origin, new URLSearchParams(entry.hash.slice(1)).get('access'));
    entry.hash = '';
    const view = await (await fetch(entry.href + 'api/state')).json();
    assert.equal(view.harness, 'claude-code');
    assert.equal(view.task, null);
    assert.ok(!view.workbench?.canCreateTask, 'Browser-created tasks stay Codex-only');
    const rejected = await fetch(entry.href + 'api/tasks', {
      method: 'POST',
      headers: {
        Origin: entry.origin,
        'Content-Type': 'application/json',
        'X-CD-Token': view.csrfToken,
      },
      body: JSON.stringify({ id: 'claude-browser-task', query: 'Build a page' }),
    });
    assert.ok(rejected.status >= 400, `api/tasks must not start a task (${rejected.status})`);
    assert.equal(listStates(ws).length, 0);
    assert.doesNotMatch(logs, /Unhandled|Error:/);
  },
);
