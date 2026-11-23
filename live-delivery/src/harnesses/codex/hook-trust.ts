import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { NativeRpc } from './native-rpc.js';
import { forwardedEnvNames, providerEnvNames } from './provider-env.js';

const configResponse = z.object({
  config: z
    .object({
      features: z
        .object({ hooks: z.boolean().optional(), codex_hooks: z.boolean().optional() })
        .optional(),
    })
    .passthrough(),
});
const hooksResponse = z.object({
  data: z.array(
    z.object({
      hooks: z.array(
        z.object({ pluginId: z.string().nullish(), source: z.string() }).passthrough(),
      ),
    }),
  ),
});
const pluginHook = z.object({
  handlerType: z.string(),
  sourcePath: z.string(),
  key: z.string(),
  currentHash: z.string(),
  enabled: z.boolean(),
  trustStatus: z.string(),
});

const selector = 'ld@live-delivery-local';
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Persist Codex's content hashes for this package only; never bypass hook trust. */
export async function configurePluginHooks(
  root: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  bin: string,
  options: { readOnly?: boolean; exclusive?: boolean } = {},
): Promise<void> {
  const rpc = new NativeRpc(env, workspace, bin);
  try {
    await rpc.initialize();
    if (!options.readOnly)
      await rpc.call('config/value/write', {
        keyPath: 'features.hooks',
        value: true,
        mergeStrategy: 'upsert',
      });
    const effective = configResponse.parse(
      await rpc.call('config/read', { cwd: workspace, includeLayers: false }),
    );
    if (
      effective.config.features?.hooks === false ||
      effective.config.features?.codex_hooks === false
    )
      throw new Error(
        'Hooks are disabled by an effective config layer. Open /hooks in Codex or check your project configuration.',
      );
    const getHooks = async () => {
      const response = hooksResponse.parse(await rpc.call('hooks/list', { cwds: [workspace] }));
      return response.data
        .flatMap((entry) => entry.hooks)
        .filter((hook) => hook.pluginId === selector && hook.source === 'plugin')
        .map((hook) => pluginHook.parse(hook));
    };
    if (options.exclusive) {
      const response = hooksResponse.parse(await rpc.call('hooks/list', { cwds: [workspace] }));
      if (
        response.data
          .flatMap((entry) => entry.hooks)
          .some(
            (hook) =>
              !(hook.pluginId === selector && hook.source === 'plugin') && hook.enabled !== false,
          )
      )
        throw new Error(
          'Additional hooks are enabled in this workspace. Browser tasks only run the verified ld hooks. Review or disable the other hooks before retrying.',
        );
    }
    let hooks = await getHooks();
    if (hooks.length !== 6)
      throw new Error(
        'Expected six ld hooks. Reinstall this package, or open /hooks in Codex to inspect errors.',
      );
    // Trust only scripts identical to this reviewed package; use Codex's own hashes
    // and configuration API, not an all-hooks bypass or private state edits.
    for (const hook of hooks) {
      const installed = path.dirname(path.dirname(hook.sourcePath));
      const forwarded = new Set(forwardedEnvNames(installed));
      if (providerEnvNames(effective.config).some((name) => !forwarded.has(name)))
        throw new Error(
          'The installed plugin does not forward the current model provider environment. Rerun the installer with --install-only, then open a new Codex session.',
        );
      if (
        hook.handlerType !== 'command' ||
        digest(path.join(installed, 'dist/hook.mjs')) !==
          digest(path.join(root, 'dist/hook.mjs')) ||
        digest(hook.sourcePath) !== digest(path.join(root, 'hooks/hooks.json'))
      )
        throw new Error(
          'Installed hook contents differ from this package. Reinstall before trusting.',
        );
      if (!options.readOnly)
        await rpc.call('config/value/write', {
          keyPath: `hooks.state.${JSON.stringify(hook.key)}`,
          value: { enabled: true, trusted_hash: hook.currentHash },
          mergeStrategy: 'upsert',
        });
    }
    hooks = await getHooks();
    if (hooks.some((h) => !h.enabled || h.trustStatus !== 'trusted'))
      throw new Error('Hooks are not ready. Check managed policy or open /hooks in Codex.');
  } finally {
    rpc.close();
  }
}
