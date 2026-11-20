import { authorize, fetch } from './http-client.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test(
  'native plugin serves its workspace UI before SessionStart binding, without creating a dummy task',
  { timeout: 15000 },
  async (t) => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'cd-idle-native-')),
      ws = path.join(temp, 'workspace');
    mkdirSync(ws);
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'dist/server.mjs')],
      cwd: ws,
      env: {
        PATH: process.env.PATH,
        CODEX_HOME: path.join(temp, 'home'),
        QWEN_LD_WORKSPACE: ws,
        QWEN_LD_INSTANCE_ID: 'idle-' + path.basename(temp),
        QWEN_LD_WORKBENCH_STATE: path.join(temp, 'private'),
        QWEN_LD_WORKSPACE_ROOT: path.join(temp, 'workspaces'),
        QWEN_LD_PORT: '0',
        QWEN_LD_OPEN_BROWSER: 'never',
      },
      stderr: 'pipe',
    });
    let logs = '';
    transport.stderr?.on('data', (c) => (logs += c));
    const client = new Client({ name: 'idle-native-fixture', version: '1' });
    t.after(() => client.close());
    await client.connect(transport);
    let url;
    for (let i = 0; i < 100 && !url; i++) {
      url = logs.match(/Delivery page: (http:\/\/[^\s]+)/)?.[1];
      if (!url) await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(url, 'Plugin must expose UI before the first task');
    const entry = new URL(url),
      token = new URLSearchParams(entry.hash.slice(1)).get('access');
    authorize(entry.origin, token);
    entry.hash = '';
    url = entry.href;
    await new Promise((r) => setTimeout(r, 1700)); // Exercise the host refresh timer as well.
    const view = await (await fetch(url + 'api/state')).json();
    assert.equal(view.task, null);
    assert.equal(view.workbench.canCreateTask, true);
    assert.equal(view.workbench.runs.length, 0);
    const address = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i.family === 'IPv4' && !i.internal)?.address;
    if (address) {
      const remote = new URL(url);
      remote.hostname = address;
      authorize(remote.origin, token);
      const accessed = await fetch(remote.href + 'api/state');
      assert.equal(accessed.status, 200, 'Default server binding accepts the actual server IP');
      const remoteView = await accessed.json();
      assert.equal(remoteView.workbench.canCreateTask, true);
      assert.ok(logs.includes(remote.href), 'Startup notice includes the server IP URL');
    }

    assert.doesNotMatch(logs, /Unhandled|Error:/);
  },
);
for (const harness of ['codex', 'claude-code']) {
  const pluginRoot = harness === 'codex' ? root : path.join(root, 'claude-code');
  const server = path.join(pluginRoot, 'dist/server.mjs');
  if (!existsSync(server)) continue;
  test(
    `${harness}: real stdio MCP, snapshot HTTP/ZIP, stop and empty-publish behavior`,
    { timeout: 20000 },
    async (t) => {
      const ws = mkdtempSync(path.join(os.tmpdir(), 'ld-mcp-'));
      t.after(() => rmSync(ws, { recursive: true, force: true }));
      mkdirSync(path.join(ws, 'site'));
      writeFileSync(path.join(ws, 'site/index.html'), '<script src="app.js"></script>');
      writeFileSync(path.join(ws, 'site/app.js'), 'window.version=1;');
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [server],
        cwd: ws,
        env: {
          ...process.env,
          QWEN_LD_EMBEDDED_TASK: '1',
          QWEN_LD_WORKSPACE: ws,
          QWEN_LD_SESSION_KEY: `${harness}:transport`,
          QWEN_LD_INSTANCE_ID: `transport-${harness}`,
          QWEN_LD_PORT: '0',
          QWEN_LD_TIME_BUDGET: '12m',
          QWEN_LD_BIND_HOST: '127.0.0.1',
          QWEN_LD_OPEN_BROWSER: 'never',
        },
        stderr: 'pipe',
      });
      let logs = '';
      transport.stderr?.on('data', (c) => {
        logs += c;
      });
      const client = new Client({ name: 'ld-fixture', version: '1.0' });
      t.after(() => client.close());
      await client.connect(transport);
      assert.deepEqual(
        (await client.listTools()).tools.map((t) => t.name),
        ['ld_begin', 'ld_publish', 'ld_status', 'ld_done'],
      );
      const call = (name, args = {}) => client.callTool({ name, arguments: args });
      const milestone = {
        id: 'first',
        title: 'First',
        scope: 'Usable site',
        acceptance: ['Opens'],
        target_after: '1m',
      };
      const start = await call('ld_begin', { task: 'HTML site', milestones: [milestone] });
      const s = start.structuredContent.state;
      assert.equal(s.protocol, 'v1');
      assert.equal(s.stateVersion, 1);
      assert.equal(s.timeBudgetSec, 720);
      const page = start.content[0].text.match(/Page: (http:\/\/\S+)/)[1];
      assert.equal(new URL(page).pathname, '/live-delivery/');
      const base = page.split('/?')[0];
      authorize(base, new URLSearchParams(new URL(page).hash.slice(1)).get('access'));
      const miss = await call('ld_publish', { paths: ['missing.md'] });
      assert.equal(miss.isError, true);
      assert.equal(miss.structuredContent.version_consumed, false);
      const first = await call('ld_publish', {
        paths: ['site'],
        preview_entry: 'site/index.html',
        milestone_id: 'first',
        plan_revision: 1,
        checks: [{ label: 'Opens', result: 'passed' }],
      });
      assert.equal(first.structuredContent.published.version, 1);
      assert.equal(
        await (await fetch(`${base}/raw/${s.id}/1/site/app.js`)).text(),
        'window.version=1;',
      );
      writeFileSync(path.join(ws, 'site/app.js'), 'window.version=2;');
      await call('ld_begin', {
        task: 'HTML site',
        next_milestone: { ...milestone, id: 'second', target_after: '2m' },
        plan_revision: 1,
      });
      await call('ld_publish', {
        paths: ['site'],
        preview_entry: 'site/index.html',
        milestone_id: 'second',
        plan_revision: 2,
        checks: [{ label: 'Opens', result: 'passed' }],
      });
      assert.equal(
        await (await fetch(`${base}/raw/${s.id}/1/site/app.js`)).text(),
        'window.version=1;',
      );
      assert.equal(
        await (await fetch(`${base}/raw/${s.id}/2/site/app.js`)).text(),
        'window.version=2;',
      );
      const zip = Buffer.from(await (await fetch(`${base}/zip/${s.id}/1`)).arrayBuffer());
      assert.equal(zip.readUInt32LE(0), 0x04034b50);
      assert.ok(zip.includes(Buffer.from('window.version=1;')));
      assert.match(await (await fetch(page)).text(), /locales.js/);
      const observed = await (await fetch(`${base}/api/state?s=${s.id}`)).json();
      assert.equal(observed.task.request, 'HTML site');
      const headers = {
        Origin: new URL(base).origin,
        'Content-Type': 'application/json',
        'X-CD-Token': observed.csrfToken,
      };
      assert.equal(
        (
          await fetch(`${base}/api/wrap-up`, {
            method: 'POST',
            body: JSON.stringify({ session_id: s.id }),
            headers: { ...headers, Origin: 'https://example.org' },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${base}/api/wrap-up`, {
            method: 'POST',
            body: JSON.stringify({ session_id: s.id }),
            headers,
          })
        ).status,
        200,
      );
      const requested = (await call('ld_status')).structuredContent.state;
      assert.equal(requested.status, 'delivered');
      assert.equal(requested.stopRequest.reason, 'user');
      assert.equal(requested.stopRequest.confirmedTs, undefined);
      const { spawnSync } = await import('node:child_process');
      const stopped = spawnSync(process.execPath, [path.join(pluginRoot, 'dist/hook.mjs')], {
        env: {
          ...process.env,
          QWEN_LD_WORKSPACE: ws,
          QWEN_LD_SESSION_KEY: `${harness}:transport`,
          QWEN_LD_INSTANCE_ID: `transport-${harness}`,
        },
        input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'transport', cwd: ws }),
        encoding: 'utf8',
      });
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.equal((await call('ld_publish', { paths: ['site'] })).isError, true);
      assert.equal((await call('ld_status')).structuredContent.state.status, 'paused');
      assert.equal((await fetch(`${base}/raw/%2e%2e%2foutside/1/site/app.js`)).status, 400);
      assert.doesNotMatch(logs, /Unhandled|Error:/);
    },
  );
}
