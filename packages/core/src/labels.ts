import type { Label } from './types.js';

export const STATUS_PREFIX = 'status:' as const;
export const AGENT_PREFIX = 'agent:' as const;
export const ARCHIVED_LABEL = 'archived' as const;

export const STATUS_LABELS = {
  backlog: { name: 'status:backlog', color: 'cccccc', description: 'In the backlog' },
  todo: { name: 'status:todo', color: 'fef2c0', description: 'Ready to work on' },
  inProgress: {
    name: 'status:in-progress',
    color: 'fbca04',
    description: 'Being worked on',
  },
  review: { name: 'status:review', color: '0e8a16', description: 'Awaiting review' },
  done: { name: 'status:done', color: '6c757d', description: 'Done' },
} as const satisfies Record<string, Label>;

export const AGENT_LABELS = {
  idle: { name: 'agent:idle', color: 'ededed', description: 'No agent attached' },
  queued: { name: 'agent:queued', color: 'a2eeef', description: 'Agent queued to run' },
  running: { name: 'agent:running', color: '5319e7', description: 'Agent running' },
  blocked: { name: 'agent:blocked', color: 'd93f0b', description: 'Agent waiting on user' },
  review: { name: 'agent:review', color: '0e8a16', description: 'PR open for review' },
  failed: { name: 'agent:failed', color: 'b60205', description: 'Agent failed' },
  autoReviewed: { name: 'agent:auto-reviewed', color: '1d76db', description: 'Auto-reviewed and fixed by agent' },
} as const satisfies Record<string, Label>;

export type StatusKey = keyof typeof STATUS_LABELS;
export type AgentKey = keyof typeof AGENT_LABELS;

export const ALL_KANBOTS_LABELS: readonly Label[] = [
  ...Object.values(STATUS_LABELS),
  ...Object.values(AGENT_LABELS),
];

export function statusFromLabels(labels: readonly string[]): StatusKey | null {
  const set = new Set(labels);
  for (const key of Object.keys(STATUS_LABELS) as StatusKey[]) {
    if (set.has(STATUS_LABELS[key].name)) return key;
  }
  return null;
}

export function agentFromLabels(labels: readonly string[]): AgentKey | null {
  const set = new Set(labels);
  for (const key of Object.keys(AGENT_LABELS) as AgentKey[]) {
    if (set.has(AGENT_LABELS[key].name)) return key;
  }
  return null;
}

export function withStatusLabel(labels: readonly string[], next: StatusKey): string[] {
  const stripped = labels.filter((l) => !l.startsWith(STATUS_PREFIX));
  return [...stripped, STATUS_LABELS[next].name];
}

export function withAgentLabel(labels: readonly string[], next: AgentKey): string[] {
  const stripped = labels.filter((l) => !l.startsWith(AGENT_PREFIX));
  return [...stripped, AGENT_LABELS[next].name];
}
