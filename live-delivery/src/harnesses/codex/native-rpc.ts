import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};
/** Local Codex API only; no model request is made by initialize/hooks/config calls. */
export class NativeRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<number, Pending>();
  onRequest?: (message: RpcMessage) => void;
  onNotification?: (message: RpcMessage) => void;
  constructor(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), bin = 'codex') {
    this.child = spawn(bin, ['app-server', '--stdio'], {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.resume(); // Do not echo provider configuration or private server logs.
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message: RpcMessage;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        message = parsed as RpcMessage;
      } catch {
        return;
      }
      if (message.method) {
        if (message.id !== undefined) this.onRequest?.(message);
        else this.onNotification?.(message);
        return;
      }
      if (typeof message.id !== 'number') return;
      const item = this.pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(message.id);
      message.error
        ? item.reject(new Error(`Codex ${message.error.code}: ${message.error.message}`))
        : item.resolve(message.result);
    });
    const ended = () => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('Codex app-server ended.'));
      }
      this.pending.clear();
    };
    this.child.on('error', ended);
    this.child.on('exit', ended);
  }
  async initialize() {
    await this.call('initialize', {
      clientInfo: { name: 'live-delivery-setup', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
  }
  call(method: string, params: unknown, timeout = 15000): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  notify(method: string, params: unknown) {
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }
  respond(id: unknown, result: unknown) {
    this.child.stdin.write(JSON.stringify({ id, result }) + '\n');
  }
  close() {
    this.child.stdin.end();
    this.child.kill('SIGTERM');
  }
}
