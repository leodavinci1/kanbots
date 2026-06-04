import { z } from 'zod';
import type { ReadyToGoManager, ReadyToGoStatus } from '../ready-to-go/manager.js';
import { parseArgs } from './errors.js';

const startSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(20).optional(),
  intervalMs: z.number().int().min(10_000).optional(),
});

export interface ReadyToGoHandlerDeps {
  readyToGo: ReadyToGoManager;
}

export function readyToGoStart(
  deps: ReadyToGoHandlerDeps,
  args: unknown,
): ReadyToGoStatus {
  const parsed = parseArgs(startSchema, args);
  const config: { maxConcurrent?: number; intervalMs?: number } = {};
  if (parsed.maxConcurrent !== undefined) config.maxConcurrent = parsed.maxConcurrent;
  if (parsed.intervalMs !== undefined) config.intervalMs = parsed.intervalMs;
  deps.readyToGo.start(config);
  return deps.readyToGo.getStatus();
}

export function readyToGoStop(deps: ReadyToGoHandlerDeps): ReadyToGoStatus {
  deps.readyToGo.stop();
  return deps.readyToGo.getStatus();
}

export function readyToGoGetStatus(deps: ReadyToGoHandlerDeps): ReadyToGoStatus {
  return deps.readyToGo.getStatus();
}
