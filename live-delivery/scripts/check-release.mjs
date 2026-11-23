import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const root = path.dirname(pluginRoot);
export const pluginFiles = new Set([
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'qwen-extension.json',
  'hooks/hooks.json',
  'skills/go/SKILL.md',
  'skills/install/SKILL.md',
  'dist/server.mjs',
  'dist/hook.mjs',
  'dist/viewer.mjs',
  'dist/workbench.mjs',
  'dist/setup.mjs',
  'install.sh',
  'package.json',
  'LICENSE',
]);
export const runtimeFiles = new Set([
  ...[...pluginFiles].map((file) => `live-delivery/${file}`),
  '.agents/plugins/marketplace.json',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/assets/workbench.png',
  'docs/assets/workbench-en.png',
  'docs/assets/lifecycle.png',
  'docs/assets/lifecycle-en.png',
  'docs/assets/header.png',
  'docs/assets/header-en.png',
  'docs/assets/orbit-live-delivery-zh.gif',
  'docs/assets/orbit-live-delivery-en.gif',
  'docs/development.md',
  'docs/development.zh-CN.md',
]);

export function npm(args) {
  const result = spawnSync('npm', args, { cwd: pluginRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `npm ${args[0]} failed`);
  return JSON.parse(result.stdout)[0];
}

export function checkFileList(files) {
  const actual = new Set(files.map((file) => file.path));
  assert.deepEqual(
    [...actual].sort(),
    [...pluginFiles].sort(),
    'Unexpected or missing runtime files',
  );
  for (const file of actual)
    assert.ok(!lstatSync(path.join(pluginRoot, file)).isSymbolicLink(), `Symlink: ${file}`);
}

const excluded = new Set([
  'node_modules',
  '.test-build',
  '.live-delivery',
  '.qwen',
  '.git',
  'artifacts',
  'release',
  '.venv',
  '__pycache__',
]);
function sourceFiles(directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (excluded.has(entry.name)) return [];
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Source symlink needs review: ${path.relative(root, file)}`);
    return entry.isDirectory() ? sourceFiles(file) : [file];
  });
}

function inspectText(text, label) {
  const checks = [
    [
      'private machine path',
      /\/(?:root|home|Users)\/[^/\s"'<>]+\/|\/[A-Za-z]+\d+\/users?\/|[A-Za-z]:\\Users\\[^\\\s]+\\/,
    ],
    [
      'private network address',
      /https?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?=[:/\s])/,
    ],
    [
      'internal service address',
      /https?:\/\/[\w.-]*(?:\.internal|\.intranet|\.corp|\.local|[-.]inc\.com)(?=[:/?#\s]|$)/,
    ],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    [
      'credential-like string',
      /\b(?:sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
    ],
  ];
  for (const [kind, pattern] of checks)
    assert.ok(!pattern.test(text), `${kind} found in ${label}; inspect locally`);
}

export function checkRelease() {
  const json = (file) => JSON.parse(readFileSync(path.join(pluginRoot, file), 'utf8'));
  const pkg = json('package.json'),
    manifest = json('.codex-plugin/plugin.json'),
    lock = json('package-lock.json');
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.version, json('qwen-extension.json').version);
  assert.equal(pkg.version, lock.version);
  assert.equal(pkg.version, lock.packages[''].version);
  assert.equal(pkg.name, lock.name);
  assert.equal(pkg.private, true, 'Runtime archives are not published to npm');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(manifest.license, pkg.license);
  assert.equal(lock.packages[''].license, pkg.license);
  assert.equal(manifest.name, 'ld');
  const marketplace = json('../.agents/plugins/marketplace.json');
  assert.equal(marketplace.name, 'live-delivery-local');
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.equal(marketplace.plugins[0].source.path, './live-delivery');
  const license = readFileSync(path.join(root, 'LICENSE'), 'utf8');
  assert.equal(readFileSync(path.join(pluginRoot, 'LICENSE'), 'utf8'), license);
  for (const section of [
    'Apache License',
    'Version 2.0, January 2004',
    '3. Grant of Patent License.',
    '9. Accepting Warranty or Additional Liability.',
    'END OF TERMS AND CONDITIONS',
  ])
    assert.ok(license.includes(section), `Missing Apache-2.0 section: ${section}`);
  for (const file of [...runtimeFiles].filter((name) => name.startsWith('live-delivery/dist/'))) {
    assert.ok(
      readFileSync(path.join(root, file), 'utf8').includes(
        'Copyright (c) 2026 Qwen Live Delivery Plugin contributors',
      ),
      `Missing copyright and bundled license comments: ${file}`,
    );
  }
  for (const file of [
    'live-delivery/src/delivery/core.ts',
    'live-delivery/src/integration/server.ts',
    'README.md',
    'README.zh-CN.md',
  ]) {
    assert.ok(
      readFileSync(path.join(root, file), 'utf8').includes(pkg.version),
      `Version missing from ${file}`,
    );
  }
  const mcp = json('.mcp.json').mcpServers['live-delivery'];
  assert.equal(mcp.command, 'node');
  assert.deepEqual(mcp.args, ['dist/server.mjs']);
  assert.ok(!mcp.env, 'Do not embed environment values in the release manifest');
  for (const file of sourceFiles()) {
    const rel = path.relative(root, file),
      name = path.basename(file);
    assert.ok(
      !/^(?:\.env(?:\..*)?|auth\.json|config\.toml)$|\.(?:log|pid|zip|tgz|pem|key)$/.test(name),
      `Private or generated output in source: ${rel}`,
    );
    const data = readFileSync(file);
    if (data.includes(0)) continue;
    const text = data.toString('utf8');
    inspectText(text, rel);
    if (rel.endsWith('.md')) {
      // Only relative Markdown links; external links and heading anchors are not fetched.
      for (const match of text.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1].split('#')[0];
        if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue;
        assert.ok(
          existsSync(path.resolve(path.dirname(file), decodeURIComponent(target))),
          `Broken link in ${rel}: ${target}`,
        );
      }
    }
    if (rel === 'live-delivery/src/ui-assets.generated.ts') {
      const assets = JSON.parse(
        text
          .slice(text.indexOf('= ') + 2)
          .trim()
          .replace(/;$/, ''),
      );
      for (const [name, asset] of Object.entries(assets))
        inspectText(Buffer.from(asset.body, 'base64').toString('utf8'), `embedded UI: ${name}`);
    }
  }
  const pack = npm(['pack', '--dry-run', '--ignore-scripts', '--json']);
  checkFileList(pack.files);
  for (const file of runtimeFiles)
    assert.ok(lstatSync(path.join(root, file)).isFile(), `Missing release file: ${file}`);
  console.log(
    `Release checks passed: ${pkg.version}, ${runtimeFiles.size} allowlisted release files. Pattern scan is not a full secret audit.`,
  );
  return pack;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  checkRelease();
