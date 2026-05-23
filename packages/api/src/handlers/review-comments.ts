import { z } from 'zod';
import type { ReviewComment, ReviewCommentSide } from '@kanbots/local-store';
import type { ReviewCommentPayload } from '../bridge.js';
import { badRequest, notFound, parseArgs } from './errors.js';
import type { HandlerDeps } from './types.js';

const SIDES = ['old', 'new', 'context'] as const;

/** Cap on body length — keeps a runaway paste from ballooning the DB and
 *  blowing the prompt budget when the composer eventually splices the
 *  comments into a user message. 8 KB is room enough for a paragraph or two. */
const MAX_BODY_BYTES = 8 * 1024;

const listSchema = z
  .object({
    runId: z.number().int().positive(),
    includeConsumed: z.boolean().optional(),
  })
  .strict();

const listForFileSchema = z
  .object({
    runId: z.number().int().positive(),
    filePath: z.string().min(1).max(4096),
  })
  .strict();

const addSchema = z
  .object({
    runId: z.number().int().positive(),
    filePath: z.string().min(1).max(4096),
    lineNumber: z.number().int().positive(),
    side: z.enum(SIDES),
    body: z.string().min(1),
  })
  .strict();

const removeSchema = z.object({ id: z.number().int().positive() }).strict();

const consumeSchema = z.object({ runId: z.number().int().positive() }).strict();

function toPayload(c: ReviewComment): ReviewCommentPayload {
  return {
    id: c.id,
    runId: c.runId,
    filePath: c.filePath,
    lineNumber: c.lineNumber,
    side: c.side,
    body: c.body,
    createdAt: c.createdAt,
    consumedAt: c.consumedAt,
  };
}

function requireRun(deps: HandlerDeps, runId: number): void {
  const run = deps.store.agentRuns.findById(runId);
  if (!run) throw notFound(`agent run ${runId} not found`);
}

export async function list(
  deps: HandlerDeps,
  args: { runId: number; includeConsumed?: boolean },
): Promise<ReviewCommentPayload[]> {
  const parsed = parseArgs(listSchema, args);
  requireRun(deps, parsed.runId);
  const input: Parameters<typeof deps.store.reviewComments.list>[0] = {
    runId: parsed.runId,
  };
  if (typeof parsed.includeConsumed === 'boolean') {
    input.includeConsumed = parsed.includeConsumed;
  }
  return deps.store.reviewComments.list(input).map(toPayload);
}

export async function listForFile(
  deps: HandlerDeps,
  args: { runId: number; filePath: string },
): Promise<ReviewCommentPayload[]> {
  const parsed = parseArgs(listForFileSchema, args);
  requireRun(deps, parsed.runId);
  return deps.store.reviewComments
    .listForFile({ runId: parsed.runId, filePath: parsed.filePath })
    .map(toPayload);
}

export async function add(
  deps: HandlerDeps,
  args: {
    runId: number;
    filePath: string;
    lineNumber: number;
    side: ReviewCommentSide;
    body: string;
  },
): Promise<ReviewCommentPayload> {
  const parsed = parseArgs(addSchema, args);
  requireRun(deps, parsed.runId);
  const body = parsed.body.trim();
  if (body.length === 0) throw badRequest('comment body is empty');
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw badRequest(`comment body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const created = deps.store.reviewComments.add({
    runId: parsed.runId,
    filePath: parsed.filePath,
    lineNumber: parsed.lineNumber,
    side: parsed.side,
    body,
  });
  return toPayload(created);
}

export async function remove(
  deps: HandlerDeps,
  args: { id: number },
): Promise<{ ok: boolean }> {
  const parsed = parseArgs(removeSchema, args);
  const existing = deps.store.reviewComments.findById(parsed.id);
  if (!existing) throw notFound(`review comment ${parsed.id} not found`);
  deps.store.reviewComments.remove(parsed.id);
  return { ok: true };
}

export async function consumePending(
  deps: HandlerDeps,
  args: { runId: number },
): Promise<ReviewCommentPayload[]> {
  const parsed = parseArgs(consumeSchema, args);
  requireRun(deps, parsed.runId);
  return deps.store.reviewComments.consumePending(parsed.runId).map(toPayload);
}
