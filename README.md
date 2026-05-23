<p align="left">
  <img src="docs/assets/brand/kanbots-icon-256.png" alt="kanbots" width="96" height="96">
</p>

# kanbots

> **A kanban board that runs Claude Code and Codex agents in parallel.**
> Drop a folder. Get a board. Dispatch agents on every card — at the
> same time, each in its own worktree. Or hit autopilot and let them
> split tasks, run them in parallel slots, and check their own work
> while you sleep.

![Kanbots board overview](docs/assets/board-overview.png)

## What makes it different

- **Parallel agents on the board.** Dispatch on as many cards as you
  want; each agent runs in its own git worktree on a `kanbots/issue-N`
  branch. The board updates live as runs progress, decisions surface,
  costs accrue. Drag a card, start an agent — that's the whole loop.
- **Autopilot mode.** Hand kanbots an issue and a budget; it iterates
  in cycles until the work converges or the cost cap hits. Two flavours:
  **feature-dev** (multi-persona round-robin) and **QA** (run
  typecheck/tests/lint/e2e, fix what fails, repeat).
- **Self-evolving feature dev.** Plug in personas — product author,
  engineer, reviewer, tester — and a parallelism count (up to 4). The
  orchestrator round-robins through personas, runs slots concurrently,
  splits parent issues into subtasks, and evolves the backlog as
  agents discover work. Personas spawn personas.
- **Pick your CLI.** Claude Code or Codex. Same board, same worktrees,
  same decision UI — kanbots speaks both stream formats behind a
  single `AgentCliAdapter` interface.
- **Local-first, zero servers.** Everything lives in `.kanbots/` next
  to your repo: SQLite database, configs, worktrees. No cloud account,
  no telemetry, no HTTP server. This is the open-source desktop edition.

![Autopilot — Feature Dev modal](docs/assets/autopilot-feature-dev.png)

*Autopilot — Feature Dev: pick personas, parallelism (up to 4),
effort, and model. Slots round-robin through personas; agents split
the issue into subtasks as they go.*

## Working on a team?

**[KanBots Cloud](https://kanbots.dev)** adds real-time collaboration,
multi-user boards, and managed agent infrastructure — same UI, paid
tier. The OSS desktop stays free forever.

## Highlights

- **Kanban with five columns** (Backlog → Done) plus an Inbox for
  unlabeled cards. Drag to move; in GitHub mode the move is mirrored
  as `status:*` label edits.
- **Local-first issues** by default — stored in SQLite. Switch to
  GitHub mode to drive real issues on a repo.
- **Claude Code or Codex agents** per run, isolated in per-run
  worktrees. A pre-push hook prevents agents from pushing.
- **Live agent thread** — every `tool_use`/`tool_result` streams in.
  Decision prompts pop into the UI; click an option, the run
  continues.
- **Branch preview** — start the worktree's dev server in one click
  and open a live URL.
- **Promote** — land an agent's worktree as a real commit, or open a
  draft PR (GitHub mode).
- **Sentry import** — auto-pull error groups onto the board for
  triage; one click hands the issue to an agent.
- **MCP server** — `kanbots-mcp-server` exposes the board over Model
  Context Protocol so Cursor, Claude Desktop, or anything MCP-aware
  can drive it.

## Requirements

- **Node 20+** and **pnpm 10+**
- **`claude`** on `PATH` (Claude Code CLI) — sign in with `claude /login`
- **`codex`** on `PATH` if you want Codex agents
- **`git`**
- Optional: **`gh`** CLI for GitHub mode auth

Packaged builds for **Linux**, **macOS** (Apple Silicon + Intel), and
**Windows** (x64) are published to the
[GitHub releases page](https://github.com/leodavinci1/kanbots/releases).
macOS and Windows builds are currently unsigned. On macOS the easiest
way to install is the one-line script (downloads the .dmg and clears
the Gatekeeper quarantine flag automatically):

```sh
curl -fsSL https://kanbots.dev/install-mac.sh | bash
```

For manual install / Windows SmartScreen bypass, see
[docs/getting-started.md](docs/getting-started.md#unsigned-builds).
Releasing infrastructure lives in [docs/releasing.md](docs/releasing.md).

## Install & run

```sh
pnpm install
pnpm desktop          # build everything, open Electron
# or, for hot-reload:
pnpm desktop:dev      # Vite + tsup --watch + electronmon
```

A workspace picker opens. Pick any folder that contains a git
repository. On first open, kanbots creates `.kanbots/` (db + config +
worktrees) and drops you on the board.

See [docs/getting-started.md](docs/getting-started.md) for the full
walkthrough.

## The `.kanbots/` directory

```
.kanbots/
├── db.sqlite        # all issues, threads, runs, providers, settings
├── config.json      # workspace mode + defaults (see docs/configuration.md)
├── worktrees/       # one subdir per agent run
├── attachments/     # files dragged into chats / cards
├── mcp-runtime/     # transient MCP configs handed to claude / codex
└── promote/         # staging area when promoting a worktree to a commit
```

Nothing is written outside this directory or the worktrees it creates.

## Workspace modes

| Mode | Source of issues | Use it for |
| --- | --- | --- |
| `local` | SQLite in `.kanbots/db.sqlite` | Solo work, side projects, anywhere you don't want GitHub Issues |
| `github` | GitHub REST via Octokit | When the repo's issues already live on GitHub |

See [docs/issues.md](docs/issues.md) for auth setup and the
`IssueSource` contract.

## How an agent run works

1. Click **Dispatch** on a card.
2. kanbots creates `.kanbots/worktrees/issue-<n>-<runId>/`, branched
   from the repo's default branch.
3. It spawns `claude -p` (or `codex` exec mode) against that worktree
   with stream-JSON output, parses every event, and forwards it to the
   UI.
4. If the agent requests a decision, the run pauses and a card pops
   up. You answer it; the run continues.
5. When the run finishes (or you stop it), the worktree stays on disk:
   - **Branch preview** — start its dev server.
   - **Promote commit** — land it on your real branch.
   - **Open draft PR** — GitHub mode only.
   - **Discard** — remove worktree + branch.

A pre-push hook is installed in every worktree so agents can't push
to remote on their own. Promotion is always an explicit user step.

![Run detail with awaiting-decision prompt](docs/assets/run-detail-awaiting-decision.png)

*Issue detail: live agent thread, decision prompt with numbered
options, run stats (model, elapsed, tokens, cost), check buttons,
worktree/branch info, and a Reply box that accepts slash commands
(`/spec`, `/review`, `/split`).*

Details: [docs/agents.md](docs/agents.md).

## Autopilot

Autopilot turns dispatch from a one-shot click into a loop.

- **`feature-dev`** — Multi-persona, parallel slots (up to 4). Round-robin
  through your persona roster on the parent issue; agents split into
  subtasks as they go. Stops on completion, stop button, or session
  cost budget.
- **`qa`** — Runs configurable check commands
  (`typecheck` / `tests` / `lint` / `build` / `e2e`), optionally
  starts a dev server and watches it, and dispatches fix runs against
  whatever fails.

Both write to `autopilot_sessions` so you can watch the cycle history,
see every child run, and stop the whole tree from a single button.

Details: [docs/agents.md#autopilot](docs/agents.md#autopilot).

## Documentation

| Topic | What's there |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, first run, picking a workspace |
| [Agents](docs/agents.md) | Claude Code & Codex runs, decision prompts, containment, costs, autopilot, personas |
| [Providers](docs/providers.md) | AI providers modal — picking the agent CLI, API key storage |
| [Issues](docs/issues.md) | Local mode, GitHub mode, auth, Sentry import |
| [MCP server](docs/mcp-server.md) | Wiring `kanbots-mcp-server` into Cursor or Claude Desktop |
| [Configuration](docs/configuration.md) | `.kanbots/config.json`, env vars, check command overrides |
| [Architecture](docs/architecture.md) | Packages, IPC bridge, database, dependency graph |

## Packages

| Package | Purpose |
| --- | --- |
| [`@kanbots/core`](packages/core) | Domain types, GitHub client, `IssueSource` contract |
| [`@kanbots/local-store`](packages/local-store) | SQLite schema, migrations, repos, `LocalIssueSource` |
| [`@kanbots/dispatcher`](packages/dispatcher) | Agent runtime — spawns Claude Code / Codex, parses stream-json, manages worktrees |
| [`@kanbots/llm`](packages/llm) | CLI adapters and provider catalogue |
| [`@kanbots/api`](packages/api) | Pure handler library + agent supervisor (no HTTP server) |
| [`@kanbots/mcp`](packages/mcp) | MCP server (`kanbots-mcp-server` bin) |
| [`@kanbots/web`](packages/web) | React + Vite UI |
| [`@kanbots/desktop`](packages/desktop) | Electron shell, IPC bridge, workspace picker |

## License

MIT — see [LICENSE](LICENSE).
