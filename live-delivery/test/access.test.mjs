import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexWorkbench } from '../.test-build/dashboard.js';
import { createDeliveryServer } from '../.test-build/http.js';
import { beginCd, publishVersion } from '../.test-build/core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-access-'));
  const workspace = path.join(temp, 'workspaces', 'private-case');
  fs.mkdirSync(path.join(workspace, 'output'), { recursive: true });
  const cfg = {
    workspaceDir: workspace,
    harness: 'codex',
    instance: 'access-test',
    sessionKey: 'codex:access-test',
    basePath: '/live-delivery',
    port: 0,
    timeBudgetSec: 600,
    deliverEverySec: 60,
    minWorkingSec: 0,
    minReleases: 1,
    model: 'fixture',
    channels: false,
  };
  const state = beginCd(cfg, 'PRIVATE_TASK_TEXT').state;
  fs.writeFileSync(
    path.join(workspace, 'output/index.html'),
    '<script type="module" src="./app.js"></script>',
  );
  fs.writeFileSync(path.join(workspace, 'output/app.js'), 'window.example = 1;');
  assert.equal(
    publishVersion(cfg, { paths: ['output'], preview_entry: 'output/index.html' }).ok,
    true,
  );
  const options = {
    stateDir: path.join(temp, 'state'),
    workspaceRoot: path.dirname(workspace),
    pluginRoot: root,
    codexHome: path.join(temp, 'empty-home'),
  };
  const hosts = [];
  const start = async () => {
    const host = createCodexWorkbench(options, {});
    hosts.push(host);
    await new Promise((r) => host.server.listen(0, '127.0.0.1', r));
    return host;
  };
  t.after(async () => {
    for (const host of hosts) await host.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const host = await start(),
    origin = `http://127.0.0.1:${host.server.address().port}`,
    base = origin + '/live-delivery';
  return { host, start, options, cfg, state, origin, base };
}

test('signed preview directory navigation returns to its custom entry without losing access', async (t) => {
  const { host, cfg, origin, base } = await fixture(t);
  fs.mkdirSync(path.join(cfg.workspaceDir, 'output/sub'), { recursive: true });
  fs.writeFileSync(path.join(cfg.workspaceDir, 'output/guide.html'), '<h1>Custom home</h1>');
  fs.writeFileSync(path.join(cfg.workspaceDir, 'output/sub/index.html'), '<a href="../">Back</a>');
  assert.equal(
    publishVersion(cfg, { paths: ['output'], preview_entry: 'output/guide.html' }).ok,
    true,
  );
  const state = await (
    await fetch(base + '/api/state', { headers: { Authorization: 'Bearer ' + host.access.token } })
  ).json();
  const prefix = origin + state.releases.at(-1).previewBase;
  for (const route of ['', 'output/', 'output']) {
    const response = await fetch(prefix + route);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Custom home/);
    assert.ok(response.url.includes('/preview/'), 'Redirect retains scoped access');
  }
  assert.match(await (await fetch(prefix + 'output/sub/')).text(), /Back/);
  assert.equal((await fetch(prefix + 'output/missing.html')).status, 404);
  assert.equal((await fetch(base + '/api/state')).status, 401);
});

test('anonymous requests cannot read state, previews, downloads, or mutate the workbench', async (t) => {
  const { host, options, state, origin, base } = await fixture(t);
  for (const suffix of [
    '/api/state',
    '/raw/' + state.id + '/1/output/index.html',
    '/zip/' + state.id + '/1',
    '/r/unknown/api/state',
    '/app.js',
  ]) {
    const response = await fetch(base + suffix);
    assert.equal(response.status, 401, suffix);
    const body = await response.text();
    assert.ok(
      !body.includes(host.token) &&
        !body.includes(host.access.token) &&
        !body.includes('PRIVATE_TASK_TEXT'),
    );
  }
  assert.equal((await fetch(base + '/api/state?access=' + host.access.token)).status, 401);
  const response = await fetch(base + '/api/workspaces', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CD-Token': host.token },
    body: JSON.stringify({ name: 'unauthorized' }),
  });
  assert.equal(response.status, 401);
  assert.equal(fs.existsSync(path.join(options.workspaceRoot, 'unauthorized')), false);
  const page = await (await fetch(base + '/')).text();
  assert.match(page, /history.replaceState/);
  assert.ok(!page.includes(host.access.token) && !page.includes('PRIVATE_TASK_TEXT'));
});

test('entry credentials produce an HttpOnly session; access does not replace CSRF checks', async (t) => {
  const { host, origin, base } = await fixture(t);
  const login = (access, source = origin) =>
    fetch(base + '/api/access', {
      method: 'POST',
      headers: { Origin: source, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access }),
    });
  assert.equal((await login('invalid')).status, 401);
  assert.equal((await login(host.access.token, 'https://example.org')).status, 401);
  assert.equal((await login(host.access.token, 'null')).status, 401);
  const response = await login(host.access.token);
  assert.equal(response.status, 204);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\/live-delivery\//);
  assert.ok(
    !setCookie.includes(host.access.token),
    'Session cookie differs from the entry credential',
  );
  const cookie = setCookie.split(';')[0];
  const view = await (await fetch(base + '/api/state', { headers: { Cookie: cookie } })).json();
  assert.equal(view.task.request, 'PRIVATE_TASK_TEXT');
  assert.ok(!JSON.stringify(view).includes(host.access.token));
  const post = (headers) =>
    fetch(base + '/api/workspaces', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ name: 'authorized' }),
    });
  assert.equal((await post({})).status, 403);
  assert.equal(
    (await post({ 'X-CD-Token': view.csrfToken, Origin: 'https://example.org' })).status,
    403,
  );
  assert.equal((await post({ 'X-CD-Token': view.csrfToken })).status, 200);
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now + 13 * 60 * 60 * 1000);
  assert.equal(
    (await fetch(base + '/api/state', { headers: { Cookie: cookie } })).status,
    401,
    'Expired sessions are rejected by the server',
  );
  clock.mock.restore();
});

test('preview capabilities load relative assets but cannot control tasks or cross versions/runs', async (t) => {
  const { host, base, origin } = await fixture(t);
  const headers = { Authorization: 'Bearer ' + host.access.token };
  const view = await (await fetch(base + '/api/state', { headers })).json();
  const preview = new URL(view.releases[0].previewUrl, origin);
  assert.equal((await fetch(preview)).status, 200);
  assert.equal(
    (await fetch(preview, { headers })).status,
    200,
    'Credentialed preview also resolves',
  );
  const asset = await fetch(new URL('app.js', preview), { headers: { Origin: 'null' } });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'window.example = 1;');
  assert.equal(asset.headers.get('access-control-allow-origin'), '*');
  const capability = preview.pathname.split('/preview/')[1].split('/')[0];
  assert.equal(
    (await fetch(base + '/api/state', { headers: { Authorization: 'Bearer ' + capability } }))
      .status,
    401,
  );
  assert.equal((await fetch(preview.href.replace('/1/output/', '/2/output/'))).status, 401);
  assert.equal((await fetch(preview.href.replace(view.task.id, 'another-session'))).status, 401);
  assert.equal(
    (await fetch(preview.href.replace(view.workbench.selectedRun, 'another-run'))).status,
    401,
  );
  assert.equal((await fetch(new URL('../../../../api/state', preview))).status, 401);
  assert.equal((await fetch(preview, { method: 'POST', headers: { Origin: origin } })).status, 401);
});

test('restarting the host revokes entry and preview credentials without losing history', async (t) => {
  const f = await fixture(t);
  const headers = { Authorization: 'Bearer ' + f.host.access.token };
  const before = await (await fetch(f.base + '/api/state', { headers })).json();
  await f.host.close();
  const host = await f.start(),
    origin = `http://127.0.0.1:${host.server.address().port}`;
  assert.equal((await fetch(origin + '/live-delivery/api/state', { headers })).status, 401);
  assert.equal((await fetch(origin + before.releases[0].previewUrl)).status, 401);
  const after = await (
    await fetch(origin + '/live-delivery/api/state', {
      headers: { Authorization: 'Bearer ' + host.access.token },
    })
  ).json();
  assert.equal(after.task.id, before.task.id);
  assert.equal(after.releases.length, 1);
});

test('standalone delivery servers also require access authentication', async (t) => {
  const f = await fixture(t);
  for (const basePath of [f.cfg.basePath, '/local/preview/workbench']) {
    const cfg = { ...f.cfg, basePath };
    const server = createDeliveryServer(cfg);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const base = origin + basePath;
    assert.equal((await fetch(base + '/api/state')).status, 401);
    const response = await fetch(base + '/api/state', {
      headers: { Authorization: 'Bearer ' + cfg.accessToken },
    });
    assert.equal(response.status, 200);
    const view = await response.json();
    assert.equal((await fetch(new URL(view.releases[0].previewUrl, origin))).status, 200);
  }
});
