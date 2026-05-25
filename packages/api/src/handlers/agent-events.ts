import { z } from 'zod';
import type { EventSubscribeResult } from '../bridge.js';
import { notFound, parseArgs } from './errors.js';
import type { CreateHandlersOptions } from './types.js';

const subscribeSchema = z
  .object({
    runId: z.number().int().positive(),
    sinceSeq: z.number().int().min(-1).optional(),
    scope: z.enum(['workspace', 'chat']).optional(),
  })
  .strict();

const unsubscribeSchema = z
  .object({
    subscriptionId: z.string().min(1).max(200),
  })
  .strict();

export interface SubscribeArgs {
  runId: number;
  sinceSeq?: number;
  scope?: 'workspace' | 'chat';
}

export interface UnsubscribeArgs {
  subscriptionId: string;
}

export async function subscribe(
  opts: CreateHandlersOptions,
  args: SubscribeArgs,
): Promise<EventSubscribeResult> {
  const parsed = parseArgs(subscribeSchema, args);
  const run = opts.deps.supervisor.getRun(parsed.runId);
  if (!run) throw notFound(`agent run ${parsed.runId} not found`);
  return opts.subscriptions.register({
    runId: parsed.runId,
    ...(parsed.sinceSeq !== undefined ? { sinceSeq: parsed.sinceSeq } : {}),
  });
}

export async function unsubscribe(
  opts: CreateHandlersOptions,
  args: UnsubscribeArgs,
): Promise<void> {
  const parsed = parseArgs(unsubscribeSchema, args);
  opts.subscriptions.unregister(parsed.subscriptionId);
}
