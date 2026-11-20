import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NativeRpc } from './native-rpc.js';

type Config = Record<string, unknown>;
const record = (value: unknown): Config =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Config) : {};

/** Discover variable names from provider configuration, never credential values. */
export function providerEnvNames(config: Config): string[] {
  const names = new Set<string>();
  const add = (name: unknown) => {
    if (typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
  };
  const visit = (value: Config) => {
    for (const provider of Object.values(record(value.model_providers))) {
      const entry = record(provider);
      add(entry.env_key);
      for (const name of Object.values(record(entry.env_http_headers))) add(name);
    }
    for (const profile of Object.values(record(value.profiles))) visit(record(profile));
  };
  visit(config);
  return [...names].sort();
}

/** Uses Codex's local config API, including the selected workspace's config layers. */
export async function configuredProviderEnv(
  workspace: string,
  env: NodeJS.ProcessEnv,
  bin: string,
): Promise<string[]> {
  const rpc = new NativeRpc(env, workspace, bin);
  try {
    await rpc.initialize();
    const response = record(
      await rpc.call('config/read', { cwd: workspace, includeLayers: false }),
    );
    return providerEnvNames(record(response.config));
  } finally {
    rpc.close();
  }
}

export function forwardedEnvNames(pluginRoot: string): string[] {
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  return (manifest.mcpServers?.['live-delivery']?.env_vars ?? []).flatMap((entry: unknown) =>
    typeof entry === 'string' ? [entry] : [],
  );
}

/** Customize only an installed private copy. The distributable manifest stays provider-neutral. */
export function configureProviderEnv(pluginRoot: string, names: string[]): void {
  const file = path.join(pluginRoot, '.mcp.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const server = manifest.mcpServers['live-delivery'];
  server.env_vars = [...new Set([...server.env_vars, ...names])];
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
}

export function requireProviderEnv(config: Config, env: NodeJS.ProcessEnv): void {
  const selected = record(record(config.model_providers)[String(config.model_provider)]);
  const key = selected.env_key;
  if (typeof key === 'string' && !env[key])
    throw new Error(
      `The configured model requires environment variable ${key}, but it is unavailable to this workbench. Export it in the shell that starts Codex. If the provider configuration changed, rerun the plugin installer and open a new Codex session.`,
    );
}
