import type { HostEvent } from '../delivery/events.js';

export type CliHookEvent = HostEvent & {
  phase: 'session' | 'prompt' | 'tool-completed' | 'turn-end' | 'other';
  sessionId: string;
  workspace?: string;
  model?: string;
  replacesSession?: boolean;
  task?: string;
  transcriptPath?: string;
};

export type CliAdapter = {
  id: string;
  defaultPort: number;
  loopbackOnly?: boolean;
  instance: () => string;
  model: () => string;
  explicitSessionKey?: () => string | undefined;
  normalizeHook: (input: Record<string, unknown>, now: number) => CliHookEvent | null;
  encodeHook: (response: HookResponse, event: CliHookEvent) => unknown;
  transcriptUsage?: import('./usage.js').UsageDecoder;
  feedbackOnPrompt?: boolean;
  feedbackHandoff?: () => string | undefined;
};

export type HookResponse = {
  blockReason?: string;
  systemMessage?: string;
  additionalContext?: string;
};
