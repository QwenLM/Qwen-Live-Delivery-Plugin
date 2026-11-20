import { runHook } from './integration/hook.js';
import { cliAdapter } from './harnesses/cli-entry.js';

runHook(cliAdapter).catch((error) => {
  process.stderr.write(`[live-delivery hook] ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
