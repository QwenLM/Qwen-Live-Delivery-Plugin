import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexWorkbench } from '../.test-build/dashboard.js';
import { loadRegistry } from '../.test-build/registry.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('invalid registry contents survive failed host startup byte for byte', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-registry-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'registry.json');
  const workspaceRoot = path.join(temp, 'new-workspaces');
  for (const original of [
    '{broken json',
    'null',
    '{}',
    '{"workspaces":[],"runs":[{"status":"running"}]}',
    JSON.stringify({
      workspaces: [],
      runs: [
        {
          id: 'run',
          workspaceId: 'missing',
          sessionId: 'cd-id',
          sessionKey: 'codex:test',
          createdTs: 1,
          query: 'task',
          status: 'running',
        },
      ],
    }),
  ]) {
    fs.writeFileSync(file, original);
    assert.throws(
      () => createCodexWorkbench({ stateDir: temp, workspaceRoot, pluginRoot: root }),
      /Invalid task registry.*original file is preserved/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.existsSync(workspaceRoot), false, 'Validation precedes startup mutations');
  }
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => loadRegistry(temp), /Cannot read task registry/);
  assert.equal(fs.statSync(file).isDirectory(), true);
  fs.rmdirSync(file);
  fs.symlinkSync(path.join(temp, 'missing-target'), file);
  assert.throws(() => loadRegistry(temp), /Cannot read task registry/);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});

test('missing registry initializes; valid older records and unknown fields are preserved', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-registry-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  assert.deepEqual(loadRegistry(temp), { workspaces: [], runs: [] });
  const registry = {
    workspaces: [{ id: 'ws-1', name: 'project', path: path.join(temp, 'project'), futureField: 1 }],
    runs: [
      {
        id: 'old-run',
        workspaceId: 'ws-1',
        sessionId: 'cd-test',
        sessionKey: 'codex:old',
        createdTs: 1,
        query: 'Original task',
        status: 'running',
        pid: 123,
        pidStart: '987654',
        futureField: { retained: true },
      },
    ],
    futureField: ['preserve'],
  };
  fs.writeFileSync(path.join(temp, 'registry.json'), JSON.stringify(registry));
  assert.deepEqual(loadRegistry(temp), registry);
});
