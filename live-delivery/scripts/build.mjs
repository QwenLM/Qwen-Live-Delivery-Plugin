import { build } from 'esbuild';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
  mkdirSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dependencyNotices } from './licenses.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
copyFileSync(path.join(root, '../LICENSE'), path.join(root, 'LICENSE'));
const descriptions = JSON.parse(
  readFileSync(path.join(root, 'src/prompts/tool-descriptions.json'), 'utf8'),
);
writeFileSync(
  path.join(root, 'src/prompts.generated.ts'),
  "// Generated from this package's src/prompts/tool-descriptions.json.\nexport const TOOL_DESCRIPTIONS = " +
    JSON.stringify(descriptions, null, 2) +
    ' as const;\n',
);

const assetTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};
const assets = {};
function collectAssets(dir, prefix = '') {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + item.name;
    if (item.isDirectory()) collectAssets(path.join(dir, item.name), rel + '/');
    else
      assets[rel] = {
        type: assetTypes[path.extname(item.name)] || 'application/octet-stream',
        body: readFileSync(path.join(dir, item.name)).toString('base64'),
      };
  }
}
await build({
  entryPoints: [path.join(root, 'src/delivery/budget.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'QWEN_LD_BUDGET',
  target: 'es2022',
  outfile: path.join(root, 'ui/budget.generated.js'),
});
collectAssets(path.join(root, 'ui'));
writeFileSync(
  path.join(root, 'src/ui-assets.generated.ts'),
  '// Generated from ui/. No workspace data.\nexport const UI_ASSETS: Record<string, {type:string;body:string}> = ' +
    JSON.stringify(assets) +
    ';\n',
);

const options = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'eof',
};
const bundledPackages = new Set();
const entries = {
  server: 'server',
  hook: 'hook',
  viewer: 'workbench/viewer',
  workbench: 'harnesses/codex/workbench',
  setup: 'harnesses/codex/setup',
};
for (const [entry, source] of Object.entries(entries)) {
  const result = await build({
    ...options,
    metafile: true,
    absWorkingDir: root,
    entryPoints: [path.join(root, 'src', `${source}.ts`)],
    outfile: path.join(root, 'dist', `${entry}.mjs`),
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  const notices = dependencyNotices(root, Object.keys(result.metafile.inputs));
  appendFileSync(path.join(root, 'dist', `${entry}.mjs`), notices.comment);
  for (const id of notices.packages) bundledPackages.add(id);
}
// Claude Code installs a plugin directory on its own, so its root carries
// copies of the shared runtime; `--claude-code` selects the adapter at run time.
// The manifest, .mcp.json and hooks.json under claude-code/ are source files.
const claudeRoot = path.join(root, 'claude-code');
mkdirSync(path.join(claudeRoot, 'dist'), { recursive: true });
mkdirSync(path.join(claudeRoot, 'skills/go'), { recursive: true });
for (const entry of ['server', 'hook'])
  copyFileSync(
    path.join(root, 'dist', `${entry}.mjs`),
    path.join(claudeRoot, 'dist', `${entry}.mjs`),
  );
copyFileSync(path.join(root, 'skills/go/SKILL.md'), path.join(claudeRoot, 'skills/go/SKILL.md'));
copyFileSync(path.join(root, 'LICENSE'), path.join(claudeRoot, 'LICENSE'));
console.log(`Embedded license notices for ${bundledPackages.size} bundled dependencies.`);
rmSync(path.join(root, '.test-build'), { recursive: true, force: true });
await build({
  ...options,
  entryPoints: [
    'delivery/core',
    'delivery/budget',
    'delivery/engine',
    'delivery/state',
    'integration/config',
    'harnesses/codex/model',
    'delivery/policy',
    'integration/tools',
    'integration/usage',
    'delivery/lock',
    'delivery/publication',
    'delivery/timeline',
    'delivery/controls',
    'workbench/feedback-handoff',
    'workbench/read-model',
    'workbench/http',
    'workbench/request-body',
    'shared/process',
    'workbench/access',
    'workbench/registry',
    'harnesses/codex/hook-trust',
    'workbench/browser',
    'workbench/workbench-host',
    'harnesses/codex/native-rpc',
    'harnesses/codex/setup-diagnostics',
    'delivery/instructions',
    'workbench/prior-context',
    'harnesses/codex/provider-env',
    'integration/session-binding',
    'integration/command-hook',
    'integration/hook-activity',
    'harnesses/codex/trace',
    'harnesses/codex/dashboard',
    'harnesses/codex/cli',
  ]
    .map((source) => ({ in: path.join(root, 'src', source + '.ts'), out: path.basename(source) }))
    .concat([
      { in: path.join(root, 'src/harnesses/codex/usage.ts'), out: 'codex-usage' },
      { in: path.join(root, 'src/harnesses/claude-code/usage.ts'), out: 'claude-usage' },
    ]),
  outdir: path.join(root, '.test-build'),
});
console.log(
  'Built self-contained Live Delivery MCP server and hooks; no sibling repository required.',
);
