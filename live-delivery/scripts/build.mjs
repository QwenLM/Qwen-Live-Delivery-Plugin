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
// No argument builds every adapter. Codex output stays at the package root;
// the Claude Code plugin root is live-delivery/claude-code/.
const HARNESSES = ['codex', 'claude-code'];
const requested = process.argv.slice(2);
for (const value of requested)
  if (!HARNESSES.includes(value))
    throw new Error(`Unknown adapter "${value}". Expected: ${HARNESSES.join(', ')}.`);
const targets = requested.length ? HARNESSES.filter((h) => requested.includes(h)) : HARNESSES;
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
  entryPoints: [path.join(root, 'src/budget.ts')],
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

const baseOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'eof',
};
const optionsFor = (harness) => ({
  ...baseOptions,
  define: { QWEN_LD_HARNESS: JSON.stringify(harness) },
});
const options = optionsFor('codex');
const bundledPackages = new Set();
async function bundle(harness, pluginRoot, entries) {
  for (const entry of entries) {
    const outfile = path.join(pluginRoot, 'dist', `${entry}.mjs`);
    const result = await build({
      ...optionsFor(harness),
      metafile: true,
      absWorkingDir: root,
      entryPoints: [path.join(root, 'src', `${entry}.ts`)],
      outfile,
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
    });
    const notices = dependencyNotices(root, Object.keys(result.metafile.inputs));
    appendFileSync(outfile, notices.comment);
    for (const id of notices.packages) bundledPackages.add(id);
  }
}
if (targets.includes('codex'))
  await bundle('codex', root, ['server', 'hook', 'viewer', 'workbench', 'setup']);
if (targets.includes('claude-code')) {
  // Claude Code CLI sessions need only the MCP server and the hook entry.
  // The plugin manifest, .mcp.json and hooks.json under claude-code/ are
  // source files; the skill and LICENSE are copied so both adapters share them.
  const claudeRoot = path.join(root, 'claude-code');
  await bundle('claude-code', claudeRoot, ['server', 'hook']);
  mkdirSync(path.join(claudeRoot, 'skills/go'), { recursive: true });
  copyFileSync(path.join(root, 'skills/go/SKILL.md'), path.join(claudeRoot, 'skills/go/SKILL.md'));
  copyFileSync(path.join(root, 'LICENSE'), path.join(claudeRoot, 'LICENSE'));
}
console.log(`Embedded license notices for ${bundledPackages.size} bundled dependencies.`);
rmSync(path.join(root, '.test-build'), { recursive: true, force: true });
await build({
  ...options,
  entryPoints: [
    'core',
    'budget',
    'activity',
    'engine',
    'state',
    'config',
    'model',
    'policy',
    'tools',
    'usage',
    'lock',
    'publication',
    'timeline',
    'controls',
    'feedback-handoff',
    'read-model',
    'http',
    'request-body',
    'process',
    'access',
    'registry',
    'hook-trust',
    'browser',
    'workbench-host',
    'native-rpc',
    'setup-diagnostics',
    'instructions',
    'prior-context',
    'provider-env',
  ].map((name) => path.join(root, 'src', `${name}.ts`)),
  outdir: path.join(root, '.test-build'),
});
console.log(
  `Built self-contained MCP server and hooks for: ${targets.join(', ')}; no sibling repository required.`,
);
