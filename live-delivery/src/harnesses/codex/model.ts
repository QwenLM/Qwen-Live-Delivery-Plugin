import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

// Display metadata only: the native harness remains responsible for model,
// provider, credentials, profiles, and command-line/project overrides. Its hook
// model takes precedence once available. Before the first hook, show the user
// configuration's default instead of an empty/unknown model.
export function configuredCodexModel(env: NodeJS.ProcessEnv = process.env): string {
  if (env.QWEN_LD_MODEL) return env.QWEN_LD_MODEL;
  try {
    const root = env.CODEX_HOME || path.join(homedir(), '.codex');
    const config = parse(readFileSync(path.join(root, 'config.toml'), 'utf8'));
    return typeof config.model === 'string' && config.model.trim() ? config.model : 'unknown';
  } catch {
    return 'unknown';
  } // An optional label must never break the tools.
}
