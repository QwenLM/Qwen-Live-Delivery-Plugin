import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function requireSupportedPlatform(platform: string = process.platform): void {
  if (platform !== 'linux' && platform !== 'darwin')
    throw new Error('This plugin supports macOS and Linux. Native Windows is not supported.');
}

/** Linux start ticks are kept unchanged so existing task records still reconnect. */
export function parseLinuxStartTime(stat: string): string | undefined {
  const end = stat.lastIndexOf(')');
  if (end < 0) return undefined;
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
  return /^\d+$/.test(fields[19] ?? '') ? fields[19] : undefined;
}

/** BSD ps returns a status followed by a locale-dependent start date. */
export function parseDarwinStartTime(listing: string): string | undefined {
  const match =
    /^\s*(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(
      listing,
    );
  if (!match || /^[ZX]/.test(match[1])) return undefined;
  return 'ps:' + match[2].replace(/\s+/g, ' ');
}

/** Identify a live PID across host restarts, rejecting zombies and reused PIDs. */
export function processStartTime(
  pid: number,
  platform: string = process.platform,
): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (platform === 'linux') return parseLinuxStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (platform === 'darwin')
      return parseDarwinStartTime(
        execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
          timeout: 2000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
  } catch {
    // A process can exit between the task lookup and the OS query.
  }
  return undefined;
}
