import type { ChildProcess } from 'node:child_process';
import type { ExecutionTrace } from '../delivery/events.js';

export type ProcessIdentity = { pid?: number; pidStart?: string };
export type ResumeExecution = { sessionId: string; handoffId: string };

export type LaunchRequest = {
  runId: string;
  cwd: string;
  query: string;
  instructions: string;
  delivery: { sessionKey: string; dashboardFile: string; timeBudgetSec: number };
  resume?: ResumeExecution;
  cancelled: () => boolean;
};

export type HostedExecution = {
  id: string;
  model: string;
  privateDirectories: string[];
  redact: (text: string) => string;
  trace: (runId: string, workspaceDir: string) => ExecutionTrace;
  feedbackHandoff?: {
    sessionId: (runId: string) => string | undefined;
    interrupt: (process: ProcessIdentity, cancelled: () => boolean) => Promise<boolean>;
  };
  launch: (request: LaunchRequest) => Promise<ChildProcess | undefined>;
};
