import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId } from '@kanbots/local-store';

/**
 * Identifier of the agent CLI a discovery call is targeting. Aliased onto
 * `ProviderId` so callers can pass the same value they already store on
 * runs/providers without translating between vocabularies. The discovery
 * surface today supports both shipped agent CLIs (`claude-code`,
 * `codex-cli`); future provider additions automatically narrow this.
 */
export type AgentKey = ProviderId;

/**
 * Where a discovered command originated:
 *   - `builtin`  – ships with the agent CLI itself (e.g. Claude `/compact`).
 *   - `user`     – authored by the user under `~/.claude/commands/*.md`.
 *   - `skill`    – a Claude Code skill under `~/.claude/skills/<name>/SKILL.md`.
 *   - `kanbots`  – orchestration commands kanbots layers on top of every agent
 *                  (e.g. `/spec`, `/split`). These appear regardless of agent.
 */
export type SlashCommandSource = 'builtin' | 'user' | 'skill' | 'kanbots';

export interface SlashCommand {
  /** Command name without the leading slash, e.g. `"compact"`. */
  name: string;
  /** Short, human-readable hint (max ~120 chars). */
  description: string;
  source: SlashCommandSource;
}

const DESCRIPTION_CAP = 120;

// ──────────────────────────────────────────────────────────────────────
// Built-in catalogs
//
// Curated by hand and pinned to commands that work in a non-TTY agent
// run (the only context the composer dispatches into). TUI-only commands
// like `/theme`, `/model`, `/fast` are intentionally omitted — they only
// have meaning inside the CLI's interactive mode and would no-op or fail
// when invoked through a non-interactive run.
// ──────────────────────────────────────────────────────────────────────

const CLAUDE_BUILTINS: readonly SlashCommand[] = [
  {
    name: 'compact',
    description: 'Clear conversation history but keep a summary in context',
    source: 'builtin',
  },
  {
    name: 'review',
    description: 'Review a pull request',
    source: 'builtin',
  },
  {
    name: 'security-review',
    description: 'Complete a security review of pending changes',
    source: 'builtin',
  },
  {
    name: 'init',
    description: 'Initialize a new CLAUDE.md file with codebase documentation',
    source: 'builtin',
  },
  {
    name: 'pr-comments',
    description: 'Get comments from a GitHub pull request',
    source: 'builtin',
  },
  {
    name: 'context',
    description: 'Visualize current context usage',
    source: 'builtin',
  },
  {
    name: 'cost',
    description: 'Show the total cost and duration of the current session',
    source: 'builtin',
  },
  {
    name: 'release-notes',
    description: 'View release notes',
    source: 'builtin',
  },
];

const CODEX_BUILTINS: readonly SlashCommand[] = [
  {
    name: 'compact',
    description: 'Summarize the conversation to free tokens',
    source: 'builtin',
  },
  {
    name: 'init',
    description: 'Generate an AGENTS.md scaffold in the current directory',
    source: 'builtin',
  },
  {
    name: 'status',
    description: 'Display session configuration and token usage',
    source: 'builtin',
  },
  {
    name: 'mcp',
    description: 'List configured MCP tools',
    source: 'builtin',
  },
];

/**
 * Kanbots orchestration commands. These work the same regardless of which
 * agent CLI is selected — the composer/dispatcher recognises them ahead of
 * the agent. They take priority over any same-named builtin so users get
 * a consistent kanbots-aware behaviour for `/review`.
 */
const KANBOTS_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'spec',
    description: 'Refine acceptance criteria before dispatching the work',
    source: 'kanbots',
  },
  {
    name: 'review',
    description: 'Spawn a reviewer agent against the current changes',
    source: 'kanbots',
  },
  {
    name: 'split',
    description: 'Fan the current task out into subtasks',
    source: 'kanbots',
  },
];

/**
 * Discover the slash commands available for `agent`.
 *
 * Combines the curated built-in catalog with user-defined commands from
 * disk:
 *   - Claude Code: `${home}/.claude/commands/*.md` plus skills under
 *     `${home}/.claude/skills/<name>/SKILL.md`.
 *   - Codex: built-ins only — Codex has no user-commands surface yet.
 *
 * Kanbots orchestration commands (`/spec`, `/review`, `/split`) are always
 * appended; when one shares a name with an agent builtin, the kanbots entry
 * wins so the user sees kanbots-aware behaviour everywhere.
 *
 * Filesystem reads are tolerant — a missing directory contributes an empty
 * slice rather than throwing. Result ordering:
 *   1. Kanbots commands (in their declared order — most relevant to the
 *      composer's flow).
 *   2. Agent builtins (in their declared order).
 *   3. User commands (alphabetical by name).
 *   4. Skills (alphabetical by name).
 *
 * @param args.agent The CLI identifier to discover commands for.
 * @param args.home  Override for the user home directory. Defaults to
 *                   `os.homedir()`. Used by tests to point at a fixture.
 */
export async function discoverSlashCommands(args: {
  agent: AgentKey;
  home?: string;
}): Promise<SlashCommand[]> {
  const home = args.home ?? homedir();

  if (args.agent === 'claude-code') {
    const [userCommands, skills] = await Promise.all([
      readClaudeUserCommands(home),
      readClaudeSkills(home),
    ]);
    return mergeAndDedupe([
      ...KANBOTS_COMMANDS,
      ...CLAUDE_BUILTINS,
      ...sortByName(userCommands),
      ...sortByName(skills),
    ]);
  }

  if (args.agent === 'codex-cli') {
    return mergeAndDedupe([...KANBOTS_COMMANDS, ...CODEX_BUILTINS]);
  }

  // Exhaustiveness — if a new AgentKey lands, surface that explicitly
  // rather than silently returning an empty list.
  const exhaustive: never = args.agent;
  throw new Error(`unknown agent: ${String(exhaustive)}`);
}

/**
 * Dedupe by `name`. Earlier entries win — call sites pass `KANBOTS_COMMANDS`
 * first so kanbots variants override agent builtins of the same name.
 */
function mergeAndDedupe(items: readonly SlashCommand[]): SlashCommand[] {
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const item of items) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(item);
  }
  return out;
}

function sortByName(items: SlashCommand[]): SlashCommand[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

async function readClaudeUserCommands(home: string): Promise<SlashCommand[]> {
  const dir = join(home, '.claude', 'commands');
  const entries = await safeReadDir(dir);
  const out: SlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -'.md'.length);
    if (!isValidCommandName(name)) continue;
    const description = await readFirstLine(join(dir, entry));
    out.push({
      name,
      description: description ?? '',
      source: 'user',
    });
  }
  return out;
}

async function readClaudeSkills(home: string): Promise<SlashCommand[]> {
  const dir = join(home, '.claude', 'skills');
  const entries = await safeReadDirWithTypes(dir);
  const out: SlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!isValidCommandName(name)) continue;
    const description = await readFirstLine(join(dir, name, 'SKILL.md'));
    out.push({
      name,
      description: description ?? '',
      source: 'skill',
    });
  }
  return out;
}

async function safeReadDir(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}

async function safeReadDirWithTypes(
  path: string,
): Promise<Array<{ name: string; isDirectory: () => boolean }>> {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Read a one-line description from a markdown file. Tries hardest sources
 * first:
 *   1. A `description: "..."` key inside a leading YAML front-matter block
 *      (the canonical home of a Claude skill's description).
 *   2. The first markdown line outside the front-matter, with leading
 *      `#`/quote/list markers stripped.
 *
 * Tolerates missing files and odd whitespace; caps length so a runaway
 * description can't blow up the typeahead row.
 */
async function readFirstLine(path: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path, 'utf8');
    const lines = text.split(/\r?\n/);

    let i = 0;
    // YAML front-matter: a `---` on the very first line opens a block; the
    // next `---` closes it. Pull `description: ...` out if present, then
    // skip the rest. If the file doesn't start with `---`, the loop below
    // just processes from line 0.
    if (lines[0]?.trim() === '---') {
      let description: string | null = null;
      for (i = 1; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.trim() === '---') {
          i++; // consume closing delimiter
          break;
        }
        const m = /^\s*description\s*:\s*(.+?)\s*$/i.exec(line);
        if (m && m[1] !== undefined && description === null) {
          // Strip wrapping quotes if any.
          description = m[1].replace(/^["']|["']$/g, '').trim();
        }
      }
      if (description !== null && description.length > 0) {
        return cap(description);
      }
    }

    for (; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const cleaned = raw.replace(/^[#\s>*-]+/, '').trim();
      if (cleaned.length === 0) continue;
      // Defensive: skip any stray YAML delimiters not handled above.
      if (/^-{3,}$/.test(cleaned)) continue;
      return cap(cleaned);
    }
    return null;
  } catch {
    return null;
  }
}

function cap(text: string): string {
  return text.length > DESCRIPTION_CAP
    ? `${text.slice(0, DESCRIPTION_CAP - 1)}…`
    : text;
}

/**
 * Reject obviously-broken command names (path traversal, hidden files,
 * whitespace). Keeps the discovery surface safe even if a user drops a
 * weirdly-named file into `~/.claude/commands/`.
 */
function isValidCommandName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith('.')) return false;
  return /^[A-Za-z0-9_:.\-]+$/.test(name);
}
