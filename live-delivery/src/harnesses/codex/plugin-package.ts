import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Stage a standalone marketplace without copying development files or public docs. */
export function stagePlugin(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ['.codex-plugin', '.mcp.json', 'hooks', 'skills', 'dist', 'LICENSE'])
    cpSync(path.join(source, name), path.join(destination, name), { recursive: true });
  const index = path.join(destination, '.agents/plugins');
  mkdirSync(index, { recursive: true });
  writeFileSync(
    path.join(index, 'marketplace.json'),
    JSON.stringify(
      {
        name: 'live-delivery-local',
        plugins: [
          {
            name: 'ld',
            source: { source: 'local', path: './' },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
}
