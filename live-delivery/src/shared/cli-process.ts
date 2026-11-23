import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function processArgs(pid: number): string {
  return ps(pid, '-o', 'args=');
}

function ps(pid: number, ...args: string[]): string {
  return execFileSync('ps', ['-p', String(pid), ...args], {
    encoding: 'utf8',
    timeout: 2000,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function findCliInstance(
  matches: (name: string, pid: number) => boolean,
): string | undefined {
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 16; depth++) {
    try {
      const row = /^(\d+)\s+(.+)$/.exec(ps(pid, '-o', 'ppid=', '-o', 'comm='));
      if (!row) break;
      if (matches(path.basename(row[2]), pid)) {
        const started = ps(pid, '-o', 'lstart=');
        if (started) return `pid-${pid}-${started}`;
      }
      pid = Number(row[1]);
    } catch {
      break;
    }
  }
  return undefined;
}
