import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createCliEnvironment } from '@kanbots/dispatcher';
import { z } from 'zod';
import type { AgentRun, LearningTag, Store } from '@kanbots/local-store';
import { CURATOR_JSON_SCHEMA, CURATOR_SYSTEM_PROMPT, renderCuratorPrompt } from './prompt.js';

/** Default model used for curator dispatches — small + cheap. Override via
 *  `createCurator({ model: '...' })` for testing or experimentation. */
const DEFAULT_CURATOR_MODEL = 'claude-haiku-4-5';

/** Hard cap on a single curator dispatch. Haiku at $1/Mtok input + $5/Mtok
 *  output and a ~10k-token prompt won't approach this on its own; the cap
 *  protects against pathological cases (rich tool_result payloads pushing
 *  context, etc.). */
const DEFAULT_PER_RUN_BUDGET_USD = 0.05;

/** Default daily cap per repo. Curator runs after every successful agent
 *  run; on a busy day this caps total memory-ledger spend. */
const DEFAULT_DAILY_BUDGET_USD = 1.0;

/** How long the curator child process is allowed to run before we kill it.
 *  Curator does not invoke tools (no Read/Grep) so 60s is generous. */
const CURATOR_TIMEOUT_MS = 60_000;

const curatorOutputSchema = z.object({
  learnings: z
    .array(
      z.object({
        tag: z.enum(['convention', 'gotcha', 'fragile', 'decision-rationale']),
        content: z.string().min(10).max(800),
        confidence: z.number().min(0).max(1).optional(),
        evidence_event_seq_min: z.number().int().min(0).optional(),
        evidence_event_seq_max: z.number().int().min(0).optional(),
      }),
    )
    .max(3),
});

const claudeResultSchema = z
  .object({
    type: z.literal('result'),
    is_error: z.boolean(),
    result: z.string().optional(),
    structured_output: z.unknown().optional(),
    total_cost_usd: z.number().optional(),
  })
  .passthrough();

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => ChildProcess;

export interface CreateCuratorOptions {
  store: Store;
  /** cwd for the claude subprocess. Should be a directory with no
   *  agent-impacting state — typically the user's repo root. */
  cwd: string;
  /** Test seam to inject a fake `spawn`. */
  spawn?: SpawnFn;
  /** Override the claude binary path. */
  command?: string;
  /** Override the curator model. Defaults to Haiku. */
  model?: string;
  /** Per-run cost cap (USD). When the curator's total_cost_usd exceeds this,
   *  the result is still applied but a warning is logged. */
  perRunBudgetUsd?: number;
  /** Per-day-per-repo cost cap (USD). Curator dispatches are skipped when
   *  the cumulative spend for the calendar day already exceeds this. */
  dailyBudgetUsd?: number;
  /** Hook for tests to observe curator outcomes. Best-effort, errors are
   *  swallowed by the supervisor wrapper. */
  onResult?: (outcome: CuratorOutcome) => void;
}

export type CuratorOutcome =
  | { kind: 'skipped'; reason: 'budget' | 'no-thread' | 'no-events' }
  | { kind: 'failed'; reason: string }
  | { kind: 'completed'; appliedCount: number; costUsd: number };

export class CuratorError extends Error {
  constructor(
    message: string,
    public readonly stderr = '',
  ) {
    super(message);
    this.name = 'CuratorError';
  }
}

/**
 * Build an `onRunComplete` hook for `createSupervisor`. Each successful run
 * triggers the curator, which spawns claude haiku with a stripped-down
 * context (recent events + existing learnings), parses the JSON output,
 * and persists each entry via LearningsRepo.upsertWithDedup.
 *
 * The curator is fully decoupled from the dispatched run: errors here do
 * not affect the parent run's state. The supervisor's `void Promise.resolve(...).catch()`
 * wrapper around `onRunComplete` already swallows any throw.
 */
export function createCurator(opts: CreateCuratorOptions): (run: AgentRun) => Promise<void> {
  const store = opts.store;
  const command = opts.command ?? 'claude';
  const model = opts.model ?? DEFAULT_CURATOR_MODEL;
  const perRunBudget = opts.perRunBudgetUsd ?? DEFAULT_PER_RUN_BUDGET_USD;
  const dailyBudget = opts.dailyBudgetUsd ?? DEFAULT_DAILY_BUDGET_USD;
  const spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);

  return async function onRunComplete(run: AgentRun): Promise<void> {
    // Only successful runs feed the curator. Failed/stopped/awaiting_input
    // runs are unreliable signal sources and waste the budget.
    if (run.successSignal !== 'completed_clean' && run.successSignal !== 'promoted') {
      opts.onResult?.({ kind: 'skipped', reason: 'no-events' });
      return;
    }
    const thread = store.threads.findById(run.threadId);
    if (!thread) {
      opts.onResult?.({ kind: 'skipped', reason: 'no-thread' });
      return;
    }

    // Per-day budget gate.
    const state = store.learnings.getCuratorState(thread.repoOwner, thread.repoName);
    const today = new Date().toISOString().slice(0, 10);
    const cap = state?.dailyBudgetUsd ?? dailyBudget;
    if (state && state.spentDate === today && state.spentTodayUsd >= cap) {
      opts.onResult?.({ kind: 'skipped', reason: 'budget' });
      return;
    }

    const events = store.events.list(run.id);
    if (events.length === 0) {
      opts.onResult?.({ kind: 'skipped', reason: 'no-events' });
      return;
    }
    const existing = store.learnings.listAll({
      repoOwner: thread.repoOwner,
      repoName: thread.repoName,
      limit: 20,
    });

    const userPrompt = renderCuratorPrompt({ events, existing });
    let output: { costUsd: number; entries: z.infer<typeof curatorOutputSchema> };
    try {
      output = await runClaudeJsonSchema({
        spawn: spawnFn,
        command,
        cwd: opts.cwd,
        model,
        systemPrompt: CURATOR_SYSTEM_PROMPT,
        prompt: userPrompt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.onResult?.({ kind: 'failed', reason: message });
      return;
    }

    // Cost attribution happens regardless of whether entries were applied —
    // the spawn already happened.
    if (output.costUsd > 0) {
      store.learnings.attributeCuratorSpend(thread.repoOwner, thread.repoName, output.costUsd);
    }
    if (output.costUsd > perRunBudget) {
      // Log but don't abort — the dispatch already completed.
      // eslint-disable-next-line no-console
      console.warn(
        `[curator] dispatch for run #${run.id} cost $${output.costUsd.toFixed(4)} (cap $${perRunBudget.toFixed(2)})`,
      );
    }

    let appliedCount = 0;
    for (const entry of output.entries.learnings) {
      const upsertInput: Parameters<Store['learnings']['upsertWithDedup']>[0] = {
        repoOwner: thread.repoOwner,
        repoName: thread.repoName,
        tag: entry.tag as LearningTag,
        content: entry.content,
        sourceRunId: run.id,
      };
      if (typeof entry.confidence === 'number') upsertInput.confidence = entry.confidence;
      if (typeof entry.evidence_event_seq_min === 'number') {
        upsertInput.evidenceEventSeqMin = entry.evidence_event_seq_min;
      }
      if (typeof entry.evidence_event_seq_max === 'number') {
        upsertInput.evidenceEventSeqMax = entry.evidence_event_seq_max;
      }
      store.learnings.upsertWithDedup(upsertInput);
      appliedCount += 1;
    }
    opts.onResult?.({ kind: 'completed', appliedCount, costUsd: output.costUsd });
  };
}

interface RunClaudeOpts {
  spawn: SpawnFn;
  command: string;
  cwd: string;
  model: string;
  systemPrompt: string;
  prompt: string;
}

interface RunClaudeOutput {
  costUsd: number;
  entries: z.infer<typeof curatorOutputSchema>;
}

async function runClaudeJsonSchema(opts: RunClaudeOpts): Promise<RunClaudeOutput> {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--system-prompt',
    opts.systemPrompt,
    '--model',
    opts.model,
    '--json-schema',
    JSON.stringify(CURATOR_JSON_SCHEMA),
  ];
  const child = opts.spawn(opts.command, args, { cwd: opts.cwd, env: createCliEnvironment() });
  let stdout = '';
  let stderr = '';
  let killedByTimeout = false;
  const timer = setTimeout(() => {
    killedByTimeout = true;
    child.kill('SIGTERM');
  }, CURATOR_TIMEOUT_MS);
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  if (!child.stdin) {
    clearTimeout(timer);
    throw new CuratorError('failed to open stdin to claude');
  }
  child.stdin.write(opts.prompt);
  child.stdin.end();

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
  if (killedByTimeout) {
    throw new CuratorError(`curator timed out after ${CURATOR_TIMEOUT_MS}ms`, stderr);
  }
  if (exitCode !== 0) {
    throw new CuratorError(`claude exited with code ${exitCode}`, stderr);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new CuratorError(
      `failed to parse claude JSON output: ${err instanceof Error ? err.message : String(err)}`,
      stderr,
    );
  }
  const result = claudeResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new CuratorError(`unexpected claude output shape: ${result.error.message}`, stderr);
  }
  if (result.data.is_error) {
    throw new CuratorError(result.data.result ?? 'claude reported an error', stderr);
  }
  const entries = curatorOutputSchema.safeParse(result.data.structured_output);
  if (!entries.success) {
    throw new CuratorError(
      `curator JSON failed schema validation: ${entries.error.message}`,
      stderr,
    );
  }
  return {
    costUsd: result.data.total_cost_usd ?? 0,
    entries: entries.data,
  };
}
