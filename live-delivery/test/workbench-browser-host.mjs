import { createCodexWorkbench } from '../.test-build/dashboard.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-workbench-browser-'));
const host = createCodexWorkbench(
  {
    planMode: process.env.QWEN_LD_TEST_ROLLING === '1' ? 'rolling' : 'fixed',
    stateDir: path.join(temp, 'private'),
    workspaceRoot: path.join(temp, 'workspaces'),
    pluginRoot: root,
    codexHome: path.join(temp, 'empty-home'),
    codexBin: path.join(root, 'test/workbench-fixture.mjs'),
  },
  { PATH: process.env.PATH },
);
await new Promise((r) => host.server.listen(0, '127.0.0.1', r));
console.log(
  JSON.stringify({
    url: `http://127.0.0.1:${host.server.address().port}/live-delivery/`,
    entryUrl: `http://127.0.0.1:${host.server.address().port}/live-delivery/#access=${host.access.token}`,
    root: temp,
  }),
);
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const command = JSON.parse(line);
  if (command.action === 'finish') {
    fs.writeFileSync(path.join(temp, 'workspaces', command.name, '.finish-fixture'), 'done');
    console.log('{"ok":true}');
  } else if (command.action === 'stream') {
    fs.writeFileSync(
      path.join(temp, 'workspaces', command.name, '.stream-fixture'),
      JSON.stringify(command.records),
    );
    console.log('{"ok":true}');
  } else if (command.action === 'events') {
    fs.writeFileSync(
      path.join(temp, 'workspaces', command.name, '.events-fixture'),
      String(command.count),
    );
    console.log('{"ok":true}');
  } else if (['plan-next', 'publish-next'].includes(command.action)) {
    fs.writeFileSync(
      path.join(temp, 'workspaces', command.name, '.' + command.action + '-fixture'),
      'next',
    );
    console.log('{"ok":true}');
  } else if (command.action === 'activity') {
    fs.writeFileSync(
      path.join(temp, 'workspaces', command.name, '.activity-fixture'),
      JSON.stringify({ text: command.text, ts: command.ts }),
    );
    console.log('{"ok":true}');
  } else if (command.action === 'quit') {
    console.log('{"ok":true}');
    break;
  }
}
input.close();
process.stdin.destroy();
for (const dir of fs.readdirSync(path.join(temp, 'workspaces'), { withFileTypes: true }))
  if (dir.isDirectory())
    fs.writeFileSync(path.join(temp, 'workspaces', dir.name, '.finish-fixture'), 'done');
await new Promise((r) => setTimeout(r, 200));
await host.close();
fs.rmSync(temp, { recursive: true, force: true });
