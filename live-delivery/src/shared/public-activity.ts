import path from 'node:path';

const privatePath = /(?:^|\/)(?:\.[^/]+|auth\.json|credentials?[^/]*|config\.toml)(?:\/|$)/i;
export function publicFiles(paths: unknown[], workspace: string): string[] {
  return paths
    .flatMap((value) => {
      if (typeof value !== 'string' || /[\x00-\x1f]/.test(value)) return [];
      const rel = path
        .relative(workspace, path.resolve(workspace, value))
        .split(path.sep)
        .join('/');
      return rel && !rel.startsWith('../') && rel !== '..' && !privatePath.test(rel)
        ? [rel.slice(0, 160)]
        : [];
    })
    .slice(0, 3);
}
/** Public text only. Never accept reasoning items, tool output or arbitrary response payloads. */
export function publicAgentText(text: string): string {
  return text
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/([#?&]access=)[^\s)\]<>]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|sk_)[a-zA-Z0-9_-]{16,}/g, '[REDACTED]')
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}
