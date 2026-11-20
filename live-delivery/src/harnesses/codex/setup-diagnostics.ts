import { readFileSync } from 'node:fs';

type Warning = { code: 'full-access' | 'user-namespaces-disabled'; message: string };

// This is a read-only preflight, not a proof that the Codex sandbox can execute.
export function sandboxWarnings({
  env = process.env,
  platform = process.platform,
  readLimit = () => readFileSync('/proc/sys/user/max_user_namespaces', 'utf8'),
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readLimit?: () => string;
} = {}): Warning[] {
  if (env.QWEN_LD_TASK_SANDBOX === 'danger-full-access')
    return [
      {
        code: 'full-access',
        message:
          '警告：QWEN_LD_TASK_SANDBOX=danger-full-access 已设置。网页新任务将关闭执行沙箱，且不会逐次请求命令审批；可访问当前系统用户有权限访问的工作区外文件。\nWARNING: Browser-created tasks are configured without an execution sandbox or per-command approval. They can access files outside the workspace with your OS account permissions.',
      },
    ];
  if (platform !== 'linux') return [];
  try {
    if (readLimit().trim() === '0')
      return [
        {
          code: 'user-namespaces-disabled',
          message:
            '警告：Linux max_user_namespaces=0，Codex 的 bubblewrap 沙箱无法创建 user namespace，可能报 ENOSPC。安装可完成，但任务执行仍需修复运行环境；不会自动切换为全权限。\nWARNING: Linux max_user_namespaces=0 blocks the user namespace required by the Codex bubblewrap sandbox (ENOSPC). Installation can finish, but task execution needs a compatible environment. No automatic full-access fallback.',
        },
      ];
  } catch {
    // An unreadable sysctl is unknown, not evidence that sandbox execution works.
  }
  return [];
}
