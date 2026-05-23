import { discoverSlashCommands, type SlashCommand } from '@kanbots/llm';
import type { ProviderId } from '@kanbots/local-store';
import { z } from 'zod';
import type { SlashCommandPayload } from '../bridge.js';
import { badRequest, parseArgs } from './errors.js';
import type { HandlerDeps } from './types.js';

const SUPPORTED_AGENTS: readonly ProviderId[] = ['claude-code', 'codex-cli'];

const slashCommandsSchema = z
  .object({
    agent: z.enum(['claude-code', 'codex-cli']),
  })
  .strict();

export interface SlashCommandsArgs {
  agent: ProviderId;
}

interface CacheEntry {
  expiresAt: number;
  value: SlashCommandPayload[];
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<ProviderId, CacheEntry>();

/**
 * Discover the slash commands the agent CLI for `args.agent` will accept
 * in the current run context. Pre-shaped for typeahead consumers: an
 * already-sorted, deduped flat list of `{ name, description, source }`.
 *
 * Result is cached per-agent for 30 seconds so a burst of `/` keypresses
 * in the composer doesn't re-stat the filesystem. The TTL is short enough
 * that newly-authored user commands appear promptly without an app
 * restart.
 */
export async function slashCommands(
  _deps: HandlerDeps,
  args: SlashCommandsArgs,
): Promise<SlashCommandPayload[]> {
  const parsed = parseArgs(slashCommandsSchema, args);

  if (!SUPPORTED_AGENTS.includes(parsed.agent)) {
    throw badRequest(`unsupported agent: ${parsed.agent}`);
  }

  const cached = cache.get(parsed.agent);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const discovered = await discoverSlashCommands({ agent: parsed.agent });
  const value = discovered.map(toPayload);
  cache.set(parsed.agent, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
}

function toPayload(cmd: SlashCommand): SlashCommandPayload {
  return {
    name: cmd.name,
    description: cmd.description,
    source: cmd.source,
  };
}

/**
 * Drops cached discovery results. Exported for tests; not wired into a
 * channel. Production callers rely on the 30s TTL.
 */
export function clearSlashCommandsCache(): void {
  cache.clear();
}
