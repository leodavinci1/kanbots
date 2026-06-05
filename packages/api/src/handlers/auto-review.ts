import { z } from 'zod';
import type { AutoReviewManager, AutoReviewStatus } from '../auto-review/manager.js';
import { parseArgs } from './errors.js';

const startSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(10).optional(),
  intervalMs: z.number().int().min(10_000).optional(),
});

export interface AutoReviewHandlerDeps {
  autoReview: AutoReviewManager;
}

export function autoReviewStart(
  deps: AutoReviewHandlerDeps,
  args: unknown,
): AutoReviewStatus {
  const parsed = parseArgs(startSchema, args);
  const config: { maxConcurrent?: number; intervalMs?: number } = {};
  if (parsed.maxConcurrent !== undefined) config.maxConcurrent = parsed.maxConcurrent;
  if (parsed.intervalMs !== undefined) config.intervalMs = parsed.intervalMs;
  deps.autoReview.start(config);
  return deps.autoReview.getStatus();
}

export function autoReviewStop(deps: AutoReviewHandlerDeps): AutoReviewStatus {
  deps.autoReview.stop();
  return deps.autoReview.getStatus();
}

export function autoReviewGetStatus(deps: AutoReviewHandlerDeps): AutoReviewStatus {
  return deps.autoReview.getStatus();
}
