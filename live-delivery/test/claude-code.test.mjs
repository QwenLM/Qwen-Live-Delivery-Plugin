// Claude Code adapter: plugin layout, hook protocol and the CLI-only workbench.
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

function hookRunner({ temp, ws }, entry = path.join(claudeRoot, 'dist/hook.mjs')) {
  return (event, extra = {}) => {
    const result = spawnSync(process.execPath, [entry], {
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

test('claude-code plugin follows Claude Code plugin conventions and shares the Codex skill', () => {
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
  assert.deepEqual(mcp.mcpServers['live-delivery'].args, ['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs']);

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
        assert.equal(hook.command, 'node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs"');

  assert.equal(
    readFileSync(path.join(claudeRoot, 'skills/go/SKILL.md'), 'utf8'),
    readFileSync(path.join(pkgRoot, 'skills/go/SKILL.md'), 'utf8'),
  );
  assert.equal(
    readFileSync(path.join(claudeRoot, 'LICENSE'), 'utf8'),
    readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8'),
  );
  for (const entry of ['server', 'hook']) {
    const bundle = readFileSync(path.join(claudeRoot, 'dist', `${entry}.mjs`), 'utf8');
    assert.match(bundle, /Copyright \(c\) 2026 Qwen Live Delivery Plugin contributors/);
    assert.doesNotMatch(bundle, /QWEN_LD_HARNESS/, 'harness must be fixed at build time');
  }
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
  const hook = hookRunner(dirs, path.join(pkgRoot, 'dist/hook.mjs'));
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
  'claude-code workbench serves CLI tasks and rejects browser-created tasks',
  { timeout: 15000 },
  async (t) => {
    const { temp, ws } = workspace(t);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(claudeRoot, 'dist/server.mjs')],
      cwd: ws,
      env: {
        PATH: process.env.PATH,
        HOME: temp,
        TMPDIR: temp,
        CLAUDE_CONFIG_DIR: path.join(temp, 'claude-home'),
        QWEN_LD_WORKSPACE: ws,
        QWEN_LD_INSTANCE_ID: 'claude-workbench-' + path.basename(temp),
        QWEN_LD_WORKSPACE_ROOT: path.join(temp, 'workspaces'),
        QWEN_LD_PORT: '0',
        QWEN_LD_BIND_HOST: '127.0.0.1',
        QWEN_LD_OPEN_BROWSER: 'never',
      },
      stderr: 'pipe',
    });
    let logs = '';
    transport.stderr?.on('data', (c) => (logs += c));
    const client = new Client({ name: 'claude-workbench-fixture', version: '1' });
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
    assert.ok(url, 'Plugin must expose the workbench before the first task');
    assert.match(logs, /\[live-delivery claude-code\]/);
    const entry = new URL(url);
    authorize(entry.origin, new URLSearchParams(entry.hash.slice(1)).get('access'));
    entry.hash = '';
    const view = await (await fetch(entry.href + 'api/state')).json();
    assert.equal(view.workbench.harness, 'claude-code');
    assert.equal(view.workbench.canCreateTask, false);
    const rejected = await fetch(entry.href + 'api/tasks', {
      method: 'POST',
      headers: {
        Origin: entry.origin,
        'Content-Type': 'application/json',
        'X-CD-Token': view.csrfToken,
      },
      body: JSON.stringify({
        id: 'claude-browser-task',
        workspaceId: view.workbench.workspaces[0].id,
        query: 'Build a page',
        timeBudgetSec: 600,
      }),
    });
    assert.equal(rejected.status, 409);
    assert.match((await rejected.json()).error, /not supported for Claude Code/);
    assert.equal(listStates(ws).length, 0);
    assert.doesNotMatch(logs, /Unhandled|Error:/);
  },
);
