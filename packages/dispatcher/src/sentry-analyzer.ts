import { spawn as nodeSpawn } from 'node:child_process';
import { z } from 'zod';
import { createCliEnvironment } from './cli-env.js';
import { ComposerError, type SpawnFn } from './composer.js';

export interface SentryAnalyzerStackFrame {
  filename: string | null;
  function: string | null;
  lineno: number | null;
  inApp: boolean;
  contextLine: string | null;
}

export interface SentryAnalyzerBreadcrumb {
  timestamp: string | null;
  category: string | null;
  level: string | null;
  message: string | null;
}

export interface SentryAnalyzerInput {
  errorType: string | null;
  errorValue: string | null;
  culprit: string | null;
  permalink: string | null;
  environment: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  stackFrames: SentryAnalyzerStackFrame[];
  breadcrumbs: SentryAnalyzerBreadcrumb[];
}

export interface SentryAnalyzerSuggestion {
  verdict: 'task' | 'skip';
  confidence: 'high' | 'medium' | 'low';
  category: 'bug' | 'config' | 'flake' | 'noise';
  reasoning: string;
  suggestedTitle: string;
  suggestedBody: string;
}

export type SentryAnalyzerFn = (input: SentryAnalyzerInput) => Promise<SentryAnalyzerSuggestion>;

export interface CreateSentryAnalyzerOptions {
  cwd: string;
  command?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  spawn?: SpawnFn;
}

const DEFAULT_TIMEOUT_MS = 180_000;

const SUGGESTION_JSON_SCHEMA = {
  type: 'object',
  required: ['verdict', 'confidence', 'category', 'reasoning', 'suggestedTitle', 'suggestedBody'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['task', 'skip'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    category: { type: 'string', enum: ['bug', 'config', 'flake', 'noise'] },
    reasoning: { type: 'string', minLength: 1, maxLength: 2_000 },
    suggestedTitle: { type: 'string', minLength: 3, maxLength: 200 },
    suggestedBody: { type: 'string', minLength: 1, maxLength: 20_000 },
  },
} as const;

const DEFAULT_SYSTEM_PROMPT = `You are a triage agent reviewing a single Sentry error report from production.

The user gives you the error type, message, stack trace, and recent breadcrumbs. You have read-only access to the repo via Read, Glob, and Grep — use them to ground your analysis in actual code (find the file in the stack trace, look at surrounding logic, check related call sites). Do not exhaust the tools; a few targeted reads is enough.

Decide:
- verdict: "task" if this looks like a real bug or config issue worth fixing; "skip" if it looks like noise (transient network blip, third-party library glitch, expected user-input error, already-handled case, environmental flake).
- confidence: how sure you are about the verdict.
- category: bug | config | flake | noise.
- reasoning: 2-4 sentences explaining the verdict, grounded in what you saw in the code.

If verdict is "task":
- suggestedTitle: concise, imperative, ≤80 chars, naming the thing to fix (e.g. "Fix unhandled null in processOrder when shipping address missing").
- suggestedBody: markdown task description with sections: Symptoms (the error + frequency), Likely cause (grounded in code, cite file paths), Suggested fix (concrete approach), Acceptance criteria.

If verdict is "skip":
- suggestedTitle: still a short imperative title (in case the user disagrees and wants to convert it).
- suggestedBody: brief markdown explaining why it looks skippable + a one-paragraph fallback if the user wants to track it anyway.

Output strictly the JSON object matching the schema. Do not invent file paths or symbols you have not verified.
`;

export function createSentryAnalyzer(opts: CreateSentryAnalyzerOptions): SentryAnalyzerFn {
  const command = opts.command ?? 'claude';
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const spawn = opts.spawn ?? nodeSpawn;

  return async function analyzeSentryError(
    input: SentryAnalyzerInput,
  ): Promise<SentryAnalyzerSuggestion> {
    const stdin = formatSentryPrompt(input);
    return runClaudeForSentrySuggestion({ command, cwd, timeoutMs, systemPrompt, stdin, spawn });
  };
}

interface RunClaudeOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  systemPrompt: string;
  stdin: string;
  spawn: SpawnFn;
}

const suggestionSchema = z
  .object({
    verdict: z.enum(['task', 'skip']),
    confidence: z.enum(['high', 'medium', 'low']),
    category: z.enum(['bug', 'config', 'flake', 'noise']),
    reasoning: z.string().min(1),
    suggestedTitle: z.string().min(1),
    suggestedBody: z.string().min(1),
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

async function runClaudeForSentrySuggestion(
  opts: RunClaudeOptions,
): Promise<SentryAnalyzerSuggestion> {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--system-prompt',
    opts.systemPrompt,
    '--json-schema',
    JSON.stringify(SUGGESTION_JSON_SCHEMA),
    '--tools',
    'Read,Glob,Grep',
  ];

  const child = opts.spawn(opts.command, args, { cwd: opts.cwd, env: createCliEnvironment() });
  let stdout = '';
  let stderr = '';
  let killedByTimeout = false;

  const timer = setTimeout(() => {
    killedByTimeout = true;
    child.kill('SIGTERM');
  }, opts.timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
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

  if (killedByTimeout) {
    throw new ComposerError(`sentry analyzer timed out after ${opts.timeoutMs}ms`, stderr);
  }
  if (exitCode !== 0) {
    throw new ComposerError(`claude exited with code ${exitCode}`, stderr);
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new ComposerError('claude produced no output', stderr);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch (err) {
    throw new ComposerError(
      `claude output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      stderr,
    );
  }
  const result = claudeResultSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new ComposerError(`unexpected claude output shape: ${result.error.message}`, stderr);
  }
  if (result.data.is_error) {
    throw new ComposerError(result.data.result ?? 'claude reported an error', stderr);
  }
  const suggestion = suggestionSchema.safeParse(result.data.structured_output);
  if (!suggestion.success) {
    throw new ComposerError(
      `analyzer did not return a valid suggestion: ${suggestion.error.message}`,
      stderr,
    );
  }
  return suggestion.data;
}

function formatSentryPrompt(input: SentryAnalyzerInput): string {
  const lines: string[] = [];
  lines.push(`Sentry error report:`);
  if (input.errorType) lines.push(`Type: ${input.errorType}`);
  if (input.errorValue) lines.push(`Message: ${input.errorValue}`);
  if (input.culprit) lines.push(`Culprit: ${input.culprit}`);
  if (input.environment) lines.push(`Environment: ${input.environment}`);
  lines.push(`Occurrences: ${input.count}`);
  lines.push(`First seen: ${input.firstSeen}`);
  lines.push(`Last seen: ${input.lastSeen}`);
  if (input.permalink) lines.push(`Sentry link: ${input.permalink}`);
  lines.push('');

  if (input.stackFrames.length > 0) {
    lines.push('Stack trace (top frames first):');
    const frames = [...input.stackFrames].reverse();
    for (const f of frames) {
      const where = [f.filename ?? '<unknown>', f.lineno ? `:${f.lineno}` : ''].join('');
      const fn = f.function ? ` in ${f.function}` : '';
      const inApp = f.inApp ? ' [in-app]' : '';
      lines.push(`  ${where}${fn}${inApp}`);
      if (f.contextLine) lines.push(`    > ${f.contextLine.trim()}`);
    }
    lines.push('');
  }

  if (input.breadcrumbs.length > 0) {
    lines.push('Recent breadcrumbs (oldest → newest):');
    for (const b of input.breadcrumbs) {
      const ts = b.timestamp ?? '?';
      const cat = b.category ?? '?';
      const level = b.level ? `[${b.level}]` : '';
      const msg = b.message ?? '';
      lines.push(`  ${ts} ${cat} ${level} ${msg}`.trimEnd());
    }
    lines.push('');
  }

  lines.push(
    'Triage this error. Use Read/Glob/Grep to ground your analysis in the repo. Output a single JSON object matching the schema.',
  );
  return lines.join('\n');
}
