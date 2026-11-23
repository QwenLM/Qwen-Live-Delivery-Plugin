import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import { parse, stringify } from 'smol-toml';
import { processStartTime } from '../../shared/process.js';
import type {
  HostedExecution,
  LaunchRequest,
  ProcessIdentity,
} from '../../workbench/hosted-execution.js';
import { DEFAULT_BASE_PATH } from '../../workbench/config.js';
import { configurePluginHooks } from './hook-trust.js';
import { stagePlugin } from './plugin-package.js';
import { configureProviderEnv, providerEnvNames, requireProviderEnv } from './provider-env.js';
import { readExecutionTrace } from './trace.js';
import { FEEDBACK_RESUME_INSTRUCTIONS } from './instructions.js';

export type CodexOptions = {
  codexHome?: string;
  codexBin?: string;
  sandbox?: 'workspace-write' | 'danger-full-access';
  pluginRoot: string;
};

export class CodexExecution implements HostedExecution {
  readonly id = 'codex';
  readonly feedbackHandoff = {
    sessionId: (runId: string) => this.sessionId(runId),
    interrupt: (process: ProcessIdentity, cancelled: () => boolean) =>
      this.interrupt(process, cancelled),
  };
  readonly privateDirectories: string[];
  private sourceConfig: Record<string, unknown> = {};
  private sourceEnv: NodeJS.ProcessEnv;
  private secrets: string[];
  private runtimePlugin: string;
  private options: Required<CodexOptions> & { stateDir: string };

  constructor(stateDir: string, input: CodexOptions, env: NodeJS.ProcessEnv) {
    this.options = {
      ...input,
      stateDir,
      codexHome: path.resolve(input.codexHome ?? env.CODEX_HOME ?? path.join(homedir(), '.codex')),
      codexBin: input.codexBin ?? 'codex',
      sandbox: input.sandbox ?? 'workspace-write',
    };
    this.privateDirectories = [this.options.pluginRoot, this.options.codexHome];
    this.sourceEnv = { ...env };
    try {
      this.sourceConfig = parse(
        readFileSync(path.join(this.options.codexHome, 'config.toml'), 'utf8'),
      ) as Record<string, unknown>;
    } catch {}
    const secrets = new Set<string>();
    const collect = (obj: unknown) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [key, value] of Object.entries(obj)) {
        if (
          typeof value === 'string' &&
          /token|secret|api.?key|password|authorization/i.test(key)
        ) {
          if (env[value] && env[value]!.length > 8) secrets.add(env[value]!);
          else if (value.length > 16 && !value.startsWith('http')) {
            secrets.add(value);
            if (value.startsWith('Bearer ')) secrets.add(value.slice(7));
          }
        } else collect(value);
      }
    };
    collect(this.sourceConfig);
    try {
      collect(JSON.parse(readFileSync(path.join(this.options.codexHome, 'auth.json'), 'utf8')));
    } catch {}
    for (const [key, value] of Object.entries(env))
      if (value && value.length > 16 && /token|secret|api.?key|password/i.test(key))
        secrets.add(value);
    this.secrets = [...secrets].sort((a, b) => b.length - a.length);
    const signature = createHash('sha256')
      .update(
        readFileSync(path.join(this.options.pluginRoot, 'dist/server.mjs'), 'utf8') +
          readFileSync(path.join(this.options.pluginRoot, 'skills/go/SKILL.md'), 'utf8') +
          JSON.stringify(providerEnvNames(this.sourceConfig)),
      )
      .digest('hex')
      .slice(0, 16);
    this.runtimePlugin = path.join(this.options.stateDir, 'plugins', signature);
    if (!existsSync(path.join(this.runtimePlugin, '.ready'))) {
      stagePlugin(this.options.pluginRoot, this.runtimePlugin);
      configureProviderEnv(this.runtimePlugin, providerEnvNames(this.sourceConfig));
      writeFileSync(path.join(this.runtimePlugin, '.ready'), 'ready');
    }
  }

  get model() {
    return typeof this.sourceConfig.model === 'string' ? this.sourceConfig.model : '';
  }

  redact(text: string) {
    for (const value of this.secrets) text = text.split(value).join('[REDACTED]');
    return text;
  }

  private trajectory(runId: string) {
    return path.join(this.options.stateDir, 'runs', runId, 'trajectory.jsonl');
  }

  trace(runId: string, workspaceDir: string) {
    return readExecutionTrace(this.trajectory(runId), workspaceDir);
  }

  private async interrupt(
    { pid, pidStart }: ProcessIdentity,
    cancelled: () => boolean,
  ): Promise<boolean> {
    const live = () => !!(pid && pidStart && processStartTime(pid) === pidStart);
    if (live()) {
      try {
        process.kill(pid!, 'SIGINT');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const deadline = Date.now() + 15000;
    while (live() && Date.now() < deadline && !cancelled())
      await new Promise((resolve) => setTimeout(resolve, 100));
    return !live();
  }

  private nativeEnv(home: string, request: LaunchRequest) {
    requireProviderEnv(this.sourceConfig, this.sourceEnv);
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP'])
      if (this.sourceEnv[key]) env[key] = this.sourceEnv[key];
    for (const name of providerEnvNames(this.sourceConfig))
      if (this.sourceEnv[name]) env[name] = this.sourceEnv[name];
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY'])
      if (this.sourceEnv[key]) env[key] = this.sourceEnv[key];
    return {
      ...env,
      CODEX_HOME: home,
      QWEN_LD_EMBEDDED_TASK: '1',
      QWEN_LD_DASHBOARD_FILE: request.delivery.dashboardFile,
      QWEN_LD_WORKSPACE: request.cwd,
      QWEN_LD_SESSION_KEY: request.delivery.sessionKey,
      QWEN_LD_INSTANCE_ID: 'web-' + request.runId,
      QWEN_LD_PORT: '0',
      QWEN_LD_BIND_HOST: '127.0.0.1',
      QWEN_LD_BASE_PATH: DEFAULT_BASE_PATH,
      QWEN_LD_OPEN_BROWSER: 'never',
      QWEN_LD_TIME_BUDGET: String(request.delivery.timeBudgetSec) + 's',
    };
  }

  private async command(
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    log: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.codexBin, args, {
        env,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end();
      let text = '';
      child.stdout.on('data', (c) => (text += c));
      child.stderr.on('data', (c) => (text += c));
      const timeout = setTimeout(() => child.kill('SIGTERM'), 30000);
      child.on('error', () => {
        clearTimeout(timeout);
        reject(new Error('Codex executable could not start.'));
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        writeFileSync(log, this.redact(text), { mode: 0o600 });
        code === 0
          ? resolve()
          : reject(
              new Error('Native plugin installation failed. See the private installation log.'),
            );
      });
    });
  }
  private sessionId(runId: string): string | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(this.trajectory(runId), 'r');
      const buffer = Buffer.alloc(65536);
      const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
      for (const line of text.split('\n')) {
        try {
          const record = JSON.parse(line);
          if (
            record.type === 'thread.started' &&
            /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(record.thread_id)
          )
            return record.thread_id;
        } catch {
          /* A partial final line is not a complete event. */
        }
      }
    } catch {
      /* The native process may still be starting. */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  async launch(request: LaunchRequest) {
    const { runId, cwd, query, instructions, resume, cancelled } = request;
    const dir = path.dirname(this.trajectory(runId));
    const home = path.join(dir, 'codex-home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    const config: Record<string, unknown> = {};
    for (const key of [
      'model',
      'model_provider',
      'model_reasoning_effort',
      'model_providers',
      'chatgpt_base_url',
      'service_tier',
      'preferred_auth_method',
      'forced_login_method',
    ])
      if (this.sourceConfig[key] !== undefined) config[key] = this.sourceConfig[key];
    config.approval_policy = 'never';
    config.sandbox_mode = this.options.sandbox;
    config.features = { shell_snapshot: false, multi_agent: false };
    config.developer_instructions = instructions;
    writeFileSync(
      path.join(home, 'config.toml'),
      stringify(config as Parameters<typeof stringify>[0]),
      { mode: 0o600 },
    );
    const auth = path.join(this.options.codexHome, 'auth.json');
    if (existsSync(auth) && !existsSync(path.join(home, 'auth.json')))
      symlinkSync(auth, path.join(home, 'auth.json'));
    const env = {
      ...this.nativeEnv(home, request),
      ...(resume ? { QWEN_LD_FEEDBACK_HANDOFF: resume.handoffId } : {}),
    };
    await this.command(
      ['plugin', 'marketplace', 'add', this.runtimePlugin, '--json'],
      env,
      cwd,
      path.join(dir, 'marketplace.log'),
    );
    if (cancelled()) return;
    await this.command(
      ['plugin', 'add', 'ld@live-delivery-local', '--json'],
      env,
      cwd,
      path.join(dir, 'install.log'),
    );
    if (cancelled()) return;
    await configurePluginHooks(this.runtimePlugin, cwd, env, this.options.codexBin, {
      exclusive: true,
    });
    if (cancelled()) return;

    const output = openSync(this.trajectory(runId), 'a', 0o600);
    try {
      const errors = openSync(path.join(dir, 'stderr.log'), 'a', 0o600);
      try {
        const args = resume
          ? ['exec', 'resume', '--skip-git-repo-check', '--json', resume.sessionId, '-']
          : [
              'exec',
              '--cd',
              cwd,
              '--skip-git-repo-check',
              '--sandbox',
              this.options.sandbox,
              '--json',
              '-',
            ];
        const child = spawn(this.options.codexBin, args, {
          env,
          cwd,
          stdio: ['pipe', output, errors],
          detached: true,
        });
        child.stdin!.on('error', () => {});
        child.stdin!.end(resume ? FEEDBACK_RESUME_INSTRUCTIONS : '$ld:go ' + query);
        return child;
      } finally {
        closeSync(errors);
      }
    } finally {
      closeSync(output);
    }
  }
}
