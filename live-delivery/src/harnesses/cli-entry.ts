import { codexCli } from './codex/cli.js';
import { qwenCli } from './qwen-code/cli.js';
import type { CliAdapter } from '../integration/cli-adapter.js';

const adapters = new Map<string, CliAdapter>([['--qwen-code', qwenCli]]);
export const cliAdapter = adapters.get(process.argv[2]) ?? codexCli;
