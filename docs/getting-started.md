# Getting started with KanBots OSS Desktop

> This is the **OSS desktop edition** — local-first, runs entirely on
> your machine, no account required. For team collaboration (shared
> boards, hosted runs, billing for agent usage), see
> [KanBots Cloud](https://kanbots.dev).

This walks you through downloading the desktop app, getting the
Claude Code CLI installed, opening your first workspace, and
dispatching an agent run.

## 1. Download and install

Grab the latest build from the
[GitHub releases page](https://github.com/leodavinci1/kanbots/releases/latest).
Pick the artifact that matches your platform:

| Platform | Artifact | Notes |
| --- | --- | --- |
| Linux x64 | `kanbots-<version>-linux-x64.AppImage` | `chmod +x` and run, or wire into your launcher. |
| Linux x64 | `kanbots-<version>-linux-x64.tar.xz` | Extract anywhere, run `./kanbots`. |
| macOS Apple Silicon | `kanbots-<version>-mac-arm64.dmg` | Drag to `/Applications`. See [unsigned-builds](#unsigned-builds). |
| macOS Intel | `kanbots-<version>-mac-x64.dmg` | Drag to `/Applications`. See [unsigned-builds](#unsigned-builds). |
| Windows x64 | `kanbots-<version>-win-x64.exe` | NSIS installer. See [unsigned-builds](#unsigned-builds). |

The releasing pipeline lives in
[docs/releasing.md](releasing.md); to run from source instead, see
[build-from-source](#build-from-source-macos--windows) below.

### Unsigned builds

KanBots binaries are not yet code-signed (Apple Developer ID and
Windows EV certs are paid; we'll add them when revenue covers it).
First-launch friction is small but real:

**macOS — one-line installer (recommended).** The easiest path is to
let our installer download the .dmg, copy `kanbots.app` to
`/Applications`, and strip the Gatekeeper quarantine flag for you:

```sh
curl -fsSL https://kanbots.dev/install-mac.sh | bash
```

This avoids the Gatekeeper errors below. Inspect the script first if
you're cautious about `curl | bash` — it's plain bash, hosted by the
kanbots.dev marketing site, and only downloads our GitHub Releases
artifact and clears `com.apple.quarantine`.

**macOS — manual install.** If you'd rather drag the .dmg yourself,
Gatekeeper will block first launch with one of two messages depending
on your macOS version:

- macOS 14 and earlier: _"kanbots cannot be opened because Apple cannot
  check it for malicious software."_ Right-click the app, choose
  **Open**, then click **Open** again in the prompt.
- macOS 15+ (incl. macOS 26 / Tahoe): _"kanbots is damaged and can't be
  opened. You should move it to the Trash."_ The right-click trick no
  longer works on this wording — you have to clear the quarantine flag
  from a terminal:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/kanbots.app"
  ```

**Windows** — Microsoft Defender SmartScreen pops up: _"Windows
protected your PC."_ Click **More info → Run anyway**.

After the first launch you don't see these prompts again on the same
machine.

### Build from source (any platform)

If you'd rather run from source, you'll need **Node 20+**, **pnpm 10+**,
and **git**:

```sh
git clone https://github.com/leodavinci1/kanbots
cd kanbots
pnpm install
pnpm desktop          # build everything, open Electron
# or, with hot reload:
pnpm desktop:dev
```

## 2. Install Claude Code

KanBots dispatches agents through the **Claude Code** CLI. Without it
on your `PATH`, the **Dispatch** button will fail.

1. Install from
   <https://docs.claude.com/en/docs/claude-code> (KanBots needs
   Claude Code 1.0+).
2. Sign in once: `claude /login`.
3. Verify: `which claude` should print a path; `claude --version`
   should report a version.

KanBots inherits the environment of whatever launches it, so
authenticate Claude Code in the same shell (or in your shell rc) that
your desktop session inherits from.

> Codex is supported as an alternative — install the `codex` CLI and
> KanBots will offer it per dispatch. You need at least one of
> `claude` or `codex` available.

## 3. Open KanBots

Launching the app drops you on the **workspace picker**. Browse to
any folder that contains a git repository and click **Open**.

On first open, KanBots will:

1. Resolve the git toplevel via `git rev-parse --show-toplevel`.
2. Create `.kanbots/` next to it (`db.sqlite`, `config.json`,
   `worktrees/`, etc.).
3. Detect a GitHub remote. If `origin` exists, you can pick **GitHub
   mode**; otherwise it falls back to **Local mode**.

You can switch modes later from workspace settings.

### Where things live on disk

```
<your-repo>/
└── .kanbots/
    ├── db.sqlite              # everything: issues, runs, threads, providers
    ├── db.sqlite-wal          # WAL journal (better-sqlite3)
    ├── db.sqlite-shm          # shared memory
    ├── config.json            # workspace mode + defaults
    ├── worktrees/             # per-run git worktrees
    │   └── issue-42-7/
    ├── attachments/           # files dragged into chats / cards
    ├── mcp-runtime/           # transient MCP configs handed to claude
    └── promote/               # staging when promoting a worktree
```

`db.sqlite` is the source of truth for everything except your source
code. Add `.kanbots/` to `.gitignore` — the app prompts to do this on
first open.

Nothing is written outside the workspace folder.

## 4. Add a card and dispatch

1. Click **+ New task** in the top right.
2. Pick a template (Bug fix, Feature, Refactor, Review, Spike), write
   a description, and pick how the card should start:
   - **Spec first** — runs `/spec` on a fresh worktree and waits for
     your approval on refined acceptance criteria before
     implementation.
   - **Create & dispatch** — spawns an agent immediately on a fresh
     worktree.
   - **Queue for later** — sits in Backlog until you start it.
3. Pick the agent CLI (`claude (auto)` defaults to Claude Code; you
   can switch to Codex per dispatch), the model, and the effort.

   ![New task modal](assets/new-task-modal.png)

4. In **Local mode** the card lands as a row in `local_issues`. In
   **GitHub mode** it's posted as a real issue on the repo.

### Your first agent run

1. Open the card and click **Dispatch**.
2. Pick an agent identity (Claude Code or Codex) and a model. Confirm.
3. KanBots creates `.kanbots/worktrees/issue-<n>-<runId>/`, branches
   it from your default branch, and spawns the chosen CLI against it.
4. The detail panel switches to the live thread. Every `tool_use` and
   `tool_result` streams in.
5. If the agent asks for permission, a decision card appears. Click
   an option; the run resumes with that choice.
6. When the run finishes, you can:
   - **Branch preview** — start the worktree's dev server and open
     a live URL.
   - **Promote commit** — rebase the worktree's tip onto your branch.
   - **Open draft PR** (GitHub mode only) — push and open a draft PR.
   - **Discard** — remove the worktree and branch.

   ![Run detail showing an awaiting-decision prompt](assets/run-detail-awaiting-decision.png)

A pre-push hook is installed in every worktree, so even if the agent
runs `git push`, it will fail. Promotion is always an explicit user
step.

## Troubleshooting

### "Dispatch failed: claude not found" (Claude Code not installed)

KanBots couldn't locate the `claude` binary on your `PATH`.

- Check from a terminal: `which claude` should print a path.
- If empty, install Claude Code:
  <https://docs.claude.com/en/docs/claude-code>.
- After installing, sign in once: `claude /login`.
- If `which claude` works in your terminal but the app still fails,
  the desktop launcher is using a different `PATH`. Restart KanBots
  from the same shell where `claude` resolves, or add the install
  directory to your shell rc (e.g. `~/.zshrc`, `~/.bashrc`,
  `~/.config/fish/config.fish`) and log out / back in.

### "Not a git repository" (repo not cloned locally)

KanBots only opens **folders that contain a git repository** — it
runs `git rev-parse --show-toplevel` to find the project root and
creates worktrees relative to it. If the picker rejects a folder:

- Make sure you cloned the repo and picked the cloned folder
  (`git clone https://github.com/<owner>/<repo>`), not a download
  zip.
- If the folder _is_ a clone, run `git status` inside it from a
  terminal to confirm — submodules and shallow clones are fine.
- If you want to start a brand-new project: `git init` in an empty
  folder before pointing KanBots at it.

### "Port 8474 already in use" (dispatcher port conflict)

The local dispatcher binds to port **8474** for streaming agent
output to the renderer. If another process already holds it, agent
runs won't start.

- Find what's holding the port:
  - Linux / macOS: `lsof -i :8474` or `ss -ltnp 'sport = :8474'`.
  - Windows: `netstat -ano | findstr 8474`.
- Often it's a stale KanBots from a previous session. Kill that
  process and relaunch.
- If you need a different port, set `KANBOTS_DISPATCHER_PORT=<port>`
  in the environment KanBots inherits, then relaunch.

## Next steps

- Set up GitHub auth properly: [issues.md](issues.md#github-mode)
- Wire the MCP server into Cursor: [mcp-server.md](mcp-server.md)
- Set per-run cost budgets: [configuration.md](configuration.md#cost-budgets)
- Try parallel runs and Autopilot: [agents.md → Autopilot](agents.md#autopilot)
