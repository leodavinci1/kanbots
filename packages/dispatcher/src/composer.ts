import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createCliEnvironment } from './cli-env.js';

export type SuggesterProvider =
  | 'claude-code'
  | 'codex-cli'
  | 'gemini-cli'
  | 'amp-cli'
  | 'cursor-cli'
  | 'copilot-cli'
  | 'opencode-cli'
  | 'droid-cli'
  | 'ccr-cli'
  | 'qwen-cli'
  | 'acp';

export interface DraftIssueInput {
  description: string;
}

export interface DraftedIssue {
  title: string;
  body: string;
}

export type SuggestionEntryStatus =
  | 'backlog'
  | 'todo'
  | 'in-progress'
  | 'in-review'
  | 'done'
  | 'closed'
  | 'unlabeled';

export interface BacklogEntry {
  title: string;
  body?: string;
  status?: SuggestionEntryStatus;
  number?: number;
}

export type PlannerEvent =
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'thought'; text: string };

export type OnPlannerEvent = (event: PlannerEvent) => void;

export interface SuggestFeatureInput {
  backlog: BacklogEntry[];
  personaPrompt: string;
  provider?: SuggesterProvider;
  /** Free-form scope from the user — narrows the suggestion to a topic, area, or constraint. */
  userNotes?: string;
  onEvent?: OnPlannerEvent;
}

export interface CreateComposerOptions {
  cwd: string;
  command?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  spawn?: SpawnFn;
}

export interface CreateSuggesterOptions extends CreateComposerOptions {
  /** Override the codex binary path; defaults to 'codex'. */
  codexCommand?: string;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    detached?: boolean;
    env?: NodeJS.ProcessEnv;
  },
) => ChildProcess;

export type DraftIssueFn = (input: DraftIssueInput) => Promise<DraftedIssue>;
export type SuggestFeatureFn = (input: SuggestFeatureInput) => Promise<DraftedIssue>;

/**
 * Input for drafting an AI-generated pull-request description from a git
 * diff. Used by the `agent-runs:draft-pr-description` handler to pre-fill
 * the title/body before the user opens the draft PR — it is NOT used to
 * auto-submit. Callers MUST truncate `diff` themselves before passing it
 * in; the drafter does not re-trim.
 */
export interface DraftPrDescriptionInput {
  /** Issue title for context — keeps the title generation grounded. */
  issueTitle: string;
  /** Issue body for context — optional; may be empty. */
  issueBody?: string;
  /** Git diff text (already truncated to a sane budget by the caller). */
  diff: string;
  /** Whether the diff was truncated. The model is told so it can hedge. */
  diffTruncated?: boolean;
}

export type DraftPrDescriptionFn = (input: DraftPrDescriptionInput) => Promise<DraftedIssue>;

const DEFAULT_TIMEOUT_MS = 120_000;
// Ideation does Glob/Grep/Read across the repo and a verify pass before
// drafting, so it routinely needs more than the 2-minute draft budget.
const DEFAULT_SUGGESTER_TIMEOUT_MS = 600_000;

const ISSUE_JSON_SCHEMA = {
  type: 'object',
  required: ['title', 'body'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 3, maxLength: 200 },
    body: { type: 'string' },
  },
} as const;

const DEFAULT_SYSTEM_PROMPT = `You are an issue composer for a software project.

The user gives you a natural-language description. Produce a single well-structured GitHub issue.

You have read-only access to the repo via Read, Glob, and Grep. Investigate when it would make the issue clearer or more actionable — e.g. naming the right file/symbol — but do not over-investigate. Aim for a draft within a few tool calls.

Rules:
- Title: concise, imperative, ≤80 chars, no trailing punctuation.
- Body: markdown. Cover problem/motivation, proposed approach (if obvious from the user's input), and acceptance criteria. Reference files or symbols by path when you have grounded them in the code.
- Do NOT invent details the user did not provide and that you cannot verify. If something is unclear, write the body so the implementer knows what's underspecified rather than guessing.
- Output strictly the JSON object matching the schema.
`;

function buildSuggestSystemPrompt(personaPrompt: string, userNotes?: string): string {
  const trimmedPersona = personaPrompt.trim();
  const persona =
    trimmedPersona.length > 0
      ? trimmedPersona
      : 'You are a product strategist for a software project.';
  const trimmedNotes = userNotes?.trim() ?? '';
  const scopeBlock =
    trimmedNotes.length > 0
      ? `\n\nScope constraint from the user — your suggestion MUST fit these constraints. Do not propose anything that falls outside them:\n${trimmedNotes}\n`
      : '';
  return `${persona}${scopeBlock}

Look at the repo (use Read/Glob/Grep — start with README.md, package.json, and top-level source dirs) and the issue context the user supplies. Propose ONE concrete next feature or task that fits this project's direction and the perspective described above. Aim for a useful suggestion within a few tool calls — do not exhaustively map the codebase.

The user-supplied context lists existing issues grouped by status (backlog, todo, in-progress, in-review, done, recently closed). Treat all of these as "already covered" — do not repropose anything similar to an issue in any group, including those already shipped or in flight.

Before finalizing your proposal, you MUST verify in the workspace that the feature does not already exist:
1. Search for keywords from your candidate title/description with Grep across source dirs.
2. Glob for likely file or module names that would implement it.
3. Read any matches you find to confirm whether the capability is genuinely missing or merely incomplete.
If the candidate already exists in the workspace OR overlaps meaningfully with any item in the supplied issue context, pick a different proposal. Loop until you find something that is genuinely new.

Rules:
- Apply your perspective specifically. The suggestion should clearly reflect what someone in your role would prioritize and why.
- Pick something the project does not already have and is not represented in the supplied issue context.
- Prefer small/medium scope: something a single agent can ship as one PR.
- Title: concise, imperative, ≤80 chars, no trailing punctuation.
- Body: markdown. Explain motivation (framed from your perspective), proposed approach grounded in real files/symbols you've seen, and 2-4 acceptance criteria. Reference paths when you can. Briefly note what you searched for to confirm the feature is missing (one short sentence is fine).
- Do NOT invent files, modules, or capabilities you have not verified by reading the code. If something is uncertain, say so and let the implementer figure it out rather than guessing.
- Output strictly the JSON object matching the schema.
`;
}

const draftedSchema = z
  .object({
    title: z.string().min(1),
    body: z.string(),
  })
  .strict();

const claudeResultSchema = z
  .object({
    type: z.literal('result'),
    is_error: z.boolean(),
    subtype: z.string().optional(),
    result: z.string().optional(),
    structured_output: z.unknown().optional(),
  })
  .passthrough();

export class ComposerError extends Error {
  constructor(
    message: string,
    public readonly stderr: string = '',
  ) {
    super(message);
    this.name = 'ComposerError';
  }
}

interface RunClaudeOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  systemPrompt: string;
  stdin: string;
  spawn: SpawnFn;
  onEvent?: OnPlannerEvent;
}

async function runClaudeForDraftedIssue(opts: RunClaudeOptions): Promise<DraftedIssue> {
  const streaming = !!opts.onEvent;
  const args = [
    '-p',
    '--output-format',
    streaming ? 'stream-json' : 'json',
    ...(streaming ? ['--verbose'] : []),
    '--no-session-persistence',
    '--system-prompt',
    opts.systemPrompt,
    '--json-schema',
    JSON.stringify(ISSUE_JSON_SCHEMA),
    '--tools',
    'Read,Glob,Grep',
  ];

  const child = opts.spawn(opts.command, args, { cwd: opts.cwd, env: createCliEnvironment() });
  let stdout = '';
  let stderr = '';
  let killedByTimeout = false;
  let resultEvent: unknown = null;
  let lineBuf = '';

  const timer = setTimeout(() => {
    killedByTimeout = true;
    child.kill('SIGTERM');
  }, opts.timeoutMs);

  const handleStreamLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const event = parsed as { type?: unknown; message?: unknown };
    if (event.type === 'result') {
      resultEvent = event;
      return;
    }
    if (!opts.onEvent) return;
    if (event.type === 'assistant' && event.message && typeof event.message === 'object') {
      const content = (event.message as { content?: unknown }).content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: unknown; name?: unknown; input?: unknown; text?: unknown };
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          opts.onEvent({
            kind: 'tool',
            name: b.name,
            summary: summarizeToolUse(b.name, b.input),
          });
        } else if (b.type === 'text' && typeof b.text === 'string') {
          const text = b.text.trim();
          if (text.length > 0) {
            const oneLine = text.split('\n')[0]?.slice(0, 160) ?? '';
            if (oneLine.length > 0) {
              opts.onEvent({ kind: 'thought', text: oneLine });
            }
          }
        }
      }
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stdout += text;
    if (!streaming) return;
    lineBuf += text;
    let idx = lineBuf.indexOf('\n');
    while (idx !== -1) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      handleStreamLine(line);
      idx = lineBuf.indexOf('\n');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  if (!child.stdin) {
    clearTimeout(timer);
    throw new ComposerError('failed to open stdin to claude');
  }
  child.stdin.write(opts.stdin);
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

  if (streaming && lineBuf.length > 0) {
    handleStreamLine(lineBuf);
    lineBuf = '';
  }

  if (killedByTimeout) {
    throw new ComposerError(`composer timed out after ${opts.timeoutMs}ms`, stderr);
  }
  if (exitCode !== 0) {
    throw new ComposerError(`claude exited with code ${exitCode}`, stderr);
  }

  const parsedJson = streaming ? resultEvent : parseJsonOrThrow(stdout, stderr);
  if (parsedJson === null) {
    throw new ComposerError('claude produced no result event', stderr);
  }
  const result = claudeResultSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new ComposerError(`unexpected claude output shape: ${result.error.message}`, stderr);
  }
  if (result.data.is_error) {
    throw new ComposerError(result.data.result ?? 'claude reported an error', stderr);
  }
  const drafted = draftedSchema.safeParse(result.data.structured_output);
  if (!drafted.success) {
    throw new ComposerError(
      `agent did not return a valid drafted issue: ${drafted.error.message}`,
      stderr,
    );
  }
  return drafted.data;
}

function summarizeToolUse(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  switch (name) {
    case 'Read': {
      const p = typeof i.file_path === 'string' ? i.file_path : '';
      return p;
    }
    case 'Glob': {
      const pattern = typeof i.pattern === 'string' ? i.pattern : '';
      const path = typeof i.path === 'string' && i.path.length > 0 ? ` in ${i.path}` : '';
      return `${pattern}${path}`;
    }
    case 'Grep': {
      const pattern = typeof i.pattern === 'string' ? i.pattern : '';
      const path = typeof i.path === 'string' && i.path.length > 0 ? ` in ${i.path}` : '';
      return `${pattern}${path}`;
    }
    default:
      return '';
  }
}

export function createComposer(opts: CreateComposerOptions): DraftIssueFn {
  const command = opts.command ?? 'claude';
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const spawn = opts.spawn ?? nodeSpawn;

  return async function draftIssue(input: DraftIssueInput): Promise<DraftedIssue> {
    return runClaudeForDraftedIssue({
      command,
      cwd,
      timeoutMs,
      systemPrompt,
      stdin: input.description,
      spawn,
    });
  };
}

const DEFAULT_PR_DESCRIPTION_SYSTEM_PROMPT = `You are a senior engineer drafting a pull-request description from a git diff.

The user gives you the issue title, the issue body, and the diff. Produce a single well-structured PR description — both a concise title and a markdown body — that a reviewer can act on.

Rules:
- Title: a single line, imperative mood, ≤80 chars, no trailing punctuation. No markdown. Describe what the PR does, not what the issue asked for.
- Body: markdown. Four sections, each a level-3 heading in this exact order:
  1. \`### Summary\` — one short paragraph (~2-3 sentences) framing the change.
  2. \`### Changes\` — bullet list of the concrete edits, grouped by area when useful (file paths welcome).
  3. \`### Why\` — brief rationale tying the change back to the issue.
  4. \`### Test plan\` — checkbox list (\`- [ ]\`) of what a reviewer should verify before merging.
- Be specific and factual. Reference real file paths and symbols from the diff. Do NOT invent files that aren't in the diff.
- Total body length should be roughly 100-200 words. Resist filler.
- If the diff was truncated, say so in the Summary with one short sentence (e.g. "Diff truncated for length — focus areas summarized below.").
- Output strictly the JSON object matching the schema. No prose outside the JSON.
`;

export interface CreatePrDescriptionDrafterOptions extends CreateComposerOptions {}

export function createPrDescriptionDrafter(
  opts: CreatePrDescriptionDrafterOptions,
): DraftPrDescriptionFn {
  const command = opts.command ?? 'claude';
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const systemPrompt = opts.systemPrompt ?? DEFAULT_PR_DESCRIPTION_SYSTEM_PROMPT;
  const spawn = opts.spawn ?? nodeSpawn;

  return async function draftPrDescription(input: DraftPrDescriptionInput): Promise<DraftedIssue> {
    const truncatedNote = input.diffTruncated
      ? '\n\nNote: the diff below was truncated to keep the prompt within token limits. Summarize what you can see and hedge accordingly.'
      : '';
    const issueBody = (input.issueBody ?? '').trim();
    const bodyBlock = issueBody.length > 0 ? `\n\n### Issue body\n${issueBody}` : '';
    const stdin =
      `### Issue title\n${input.issueTitle.trim()}` +
      bodyBlock +
      `\n\n### Diff\n${input.diff}` +
      truncatedNote;
    return runClaudeForDraftedIssue({
      command,
      cwd,
      timeoutMs,
      systemPrompt,
      stdin,
      spawn,
    });
  };
}

export function createSuggester(opts: CreateSuggesterOptions): SuggestFeatureFn {
  const claudeCommand = opts.command ?? 'claude';
  const codexCommand = opts.codexCommand ?? 'codex';
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUGGESTER_TIMEOUT_MS;
  const systemPromptOverride = opts.systemPrompt;
  const spawn = opts.spawn ?? nodeSpawn;

  return async function suggestFeature(input: SuggestFeatureInput): Promise<DraftedIssue> {
    const systemPrompt =
      systemPromptOverride ?? buildSuggestSystemPrompt(input.personaPrompt, input.userNotes);
    const userPrompt = formatBacklogPrompt(input.backlog, input.userNotes);
    const provider: SuggesterProvider = input.provider ?? 'claude-code';
    if (provider === 'codex-cli') {
      const codexOpts: RunCodexOptions = {
        command: codexCommand,
        cwd,
        timeoutMs,
        systemPrompt,
        userPrompt,
        spawn,
      };
      if (input.onEvent) codexOpts.onEvent = input.onEvent;
      return runCodexForDraftedIssue(codexOpts);
    }
    // gemini-cli and amp-cli don't have a dedicated issue-drafting runner
    // yet — their stream parsers exist but the structured-JSON drafting
    // helper is claude-specific. Fall back to claude for `composer:suggest`
    // (a separate, non-agent-run path); their agent-run flows go through
    // the dispatcher's worker.ts and are unaffected.
    const runOpts: RunClaudeOptions = {
      command: claudeCommand,
      cwd,
      timeoutMs,
      systemPrompt,
      stdin: userPrompt,
      spawn,
    };
    if (input.onEvent) runOpts.onEvent = input.onEvent;
    return runClaudeForDraftedIssue(runOpts);
  };
}

const STATUS_GROUP_ORDER: ReadonlyArray<{
  status: SuggestionEntryStatus;
  heading: string;
}> = [
  { status: 'in-progress', heading: 'In progress (do not duplicate)' },
  { status: 'in-review', heading: 'In review (do not duplicate)' },
  { status: 'todo', heading: 'Up next / todo (do not duplicate)' },
  { status: 'backlog', heading: 'Backlog (do not duplicate)' },
  {
    status: 'done',
    heading: 'Done — already shipped or finished (do not propose anything similar)',
  },
  { status: 'closed', heading: 'Recently closed (do not propose anything similar)' },
  { status: 'unlabeled', heading: 'Other open issues (do not duplicate)' },
];

function renderEntry(item: BacklogEntry, idx: number): string {
  const trimmedBody = (item.body ?? '').trim();
  const summary = trimmedBody.length > 280 ? `${trimmedBody.slice(0, 280)}…` : trimmedBody;
  const ref = item.number !== undefined ? `#${item.number} ` : '';
  return summary
    ? `${idx + 1}. ${ref}${item.title}\n   ${summary.replace(/\n/g, ' ')}`
    : `${idx + 1}. ${ref}${item.title}`;
}

function formatBacklogPrompt(backlog: BacklogEntry[], userNotes?: string): string {
  const trimmedNotes = userNotes?.trim() ?? '';
  const notesBlock =
    trimmedNotes.length > 0
      ? `Additional scope from the user — narrow your suggestion to match this:\n${trimmedNotes}\n\n`
      : '';

  if (backlog.length === 0) {
    return `${notesBlock}The repo currently has no tracked issues. Suggest a strong first task for this project.`;
  }

  const sections: string[] = [];
  for (const { status, heading } of STATUS_GROUP_ORDER) {
    const entries = backlog.filter((item) => (item.status ?? 'backlog') === status);
    if (entries.length === 0) continue;
    const lines = entries.map((entry, idx) => renderEntry(entry, idx));
    sections.push(`### ${heading}\n${lines.join('\n')}`);
  }

  if (sections.length === 0) {
    // No entries had recognizable statuses — fall back to a flat list.
    const flat = backlog.map((entry, idx) => renderEntry(entry, idx)).join('\n');
    return `${notesBlock}Existing issues (do not duplicate any of these):\n\n${flat}\n\nSuggest one new feature or task that fits this project.`;
  }

  return `${notesBlock}Existing issues, grouped by status. Do not duplicate or propose anything materially similar to anything below — including items that are already in flight or have already shipped.\n\n${sections.join('\n\n')}\n\nAfter you have a candidate, verify in the workspace that the feature is genuinely missing (Grep/Glob/Read). Then suggest ONE new feature or task.`;
}

function parseJsonOrThrow(stdout: string, stderr: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new ComposerError('claude produced no output', stderr);
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new ComposerError(
      `claude output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      stderr,
    );
  }
}

const CODEX_PROMPT_DELIMITER = '\n\n---\n\n';

interface RunCodexOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  systemPrompt: string;
  userPrompt: string;
  spawn: SpawnFn;
  onEvent?: OnPlannerEvent;
}

async function runCodexForDraftedIssue(opts: RunCodexOptions): Promise<DraftedIssue> {
  // codex --output-schema requires a file path; write the schema to a temp
  // dir outside the repo so it isn't visible to the agent.
  const schemaDir = await mkdtemp(join(tmpdir(), 'kanbots-codex-suggest-'));
  const schemaPath = join(schemaDir, 'schema.json');
  await writeFile(schemaPath, JSON.stringify(ISSUE_JSON_SCHEMA), 'utf8');

  try {
    return await spawnCodex(opts, schemaPath);
  } finally {
    await rm(schemaDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function spawnCodex(opts: RunCodexOptions, schemaPath: string): Promise<DraftedIssue> {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--output-schema',
    schemaPath,
    `${opts.systemPrompt}${CODEX_PROMPT_DELIMITER}${opts.userPrompt}`,
  ];

  const child = opts.spawn(opts.command, args, { cwd: opts.cwd, env: createCliEnvironment() });
  let stderr = '';
  let killedByTimeout = false;
  let agentMessageText: string | null = null;
  let turnError: string | null = null;
  let lineBuf = '';

  const timer = setTimeout(() => {
    killedByTimeout = true;
    child.kill('SIGTERM');
  }, opts.timeoutMs);

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const ev = parsed as { type?: unknown; item?: unknown; error?: unknown; message?: unknown };
    if (ev.type === 'turn.failed') {
      const err = ev.error as { message?: unknown } | undefined;
      turnError = typeof err?.message === 'string' ? err.message : 'codex turn failed';
      return;
    }
    if (ev.type === 'error' && typeof ev.message === 'string') {
      turnError = ev.message;
      return;
    }
    if (ev.type === 'item.completed' && ev.item && typeof ev.item === 'object') {
      const item = ev.item as { type?: unknown; text?: unknown };
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        agentMessageText = item.text;
      }
      return;
    }
    if (!opts.onEvent) return;
    if (ev.type === 'item.started' && ev.item && typeof ev.item === 'object') {
      const item = ev.item as { type?: unknown; command?: unknown; query?: unknown };
      if (item.type === 'command_execution' && typeof item.command === 'string') {
        opts.onEvent({ kind: 'tool', name: 'shell', summary: item.command.slice(0, 160) });
      } else if (item.type === 'web_search' && typeof item.query === 'string') {
        opts.onEvent({ kind: 'tool', name: 'WebSearch', summary: item.query.slice(0, 160) });
      }
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    lineBuf += chunk.toString('utf8');
    let idx = lineBuf.indexOf('\n');
    while (idx !== -1) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      handleLine(line);
      idx = lineBuf.indexOf('\n');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  // codex reads the prompt from argv (passed above); close stdin so it
  // doesn't wait on it.
  child.stdin?.end();

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

  if (lineBuf.length > 0) {
    handleLine(lineBuf);
    lineBuf = '';
  }

  if (killedByTimeout) {
    throw new ComposerError(`composer timed out after ${opts.timeoutMs}ms`, stderr);
  }
  if (exitCode !== 0) {
    throw new ComposerError(
      turnError
        ? `codex exited with code ${exitCode}: ${turnError}`
        : `codex exited with code ${exitCode}`,
      stderr,
    );
  }
  if (turnError) {
    throw new ComposerError(turnError, stderr);
  }
  if (!agentMessageText) {
    throw new ComposerError('codex produced no agent message', stderr);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(agentMessageText);
  } catch {
    // Defensive: if codex wrapped the JSON in prose or fences, extract the
    // first JSON object.
    const extracted = extractFirstJsonObject(agentMessageText);
    if (extracted === null) {
      throw new ComposerError('codex output was not valid JSON', stderr);
    }
    payload = extracted;
  }

  const drafted = draftedSchema.safeParse(payload);
  if (!drafted.success) {
    throw new ComposerError(
      `codex did not return a valid drafted issue: ${drafted.error.message}`,
      stderr,
    );
  }
  return drafted.data;
}

function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
