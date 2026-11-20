import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const dependencies = {
  delivery: ['delivery', 'shared'],
  shared: ['shared'],
  workbench: ['workbench', 'delivery', 'shared', 'ui-assets.generated.js'],
  integration: ['integration', 'workbench', 'delivery', 'shared', 'prompts.generated.js'],
};

test('delivery, workbench and integration do not import concrete harnesses', () => {
  for (const [layer, allowed] of Object.entries(dependencies)) {
    const directory = path.join(src, layer);
    for (const name of readdirSync(directory, { recursive: true })) {
      if (!name.endsWith('.ts')) continue;
      const file = path.join(directory, name);
      const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
      for (const { fileName } of importedFiles) {
        if (!fileName.startsWith('.')) continue;
        const relative = path.relative(src, path.resolve(path.dirname(file), fileName));
        assert.ok(
          allowed.includes(relative.split(path.sep)[0]),
          `${layer}/${name} must not import ${relative}`,
        );
      }
    }
  }
});
