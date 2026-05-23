# Releasing kanbots desktop

The desktop app ships as binary downloads on the
[GitHub releases page](https://github.com/leodavinci1/kanbots/releases).
Builds are produced by the
[`release.yml`](../.github/workflows/release.yml) workflow on three OS
runners and uploaded to a draft release.

## Cutting a release

Releases are triggered by pushing a tag that matches `v*`.

```sh
# 1. Bump the desktop version (root and packages/desktop are independent —
#    only packages/desktop drives the artifact name, but keep them in sync
#    if you maintain a single version line).
cd packages/desktop
npm version 0.1.0 --no-git-tag-version
cd ../..
git add packages/desktop/package.json
git commit -m "chore(desktop): release v0.1.0"

# 2. Tag and push.
git tag v0.1.0
git push origin main --tags
```

The workflow:

1. Boots `ubuntu-latest`, `macos-latest`, and `windows-latest` runners in
   parallel.
2. Installs deps with pnpm + caches.
3. Bumps `packages/desktop/package.json` to match the tag (no commit) so
   electron-builder names artifacts consistently.
4. Runs `electron-builder --publish always --<platform>` on each runner.
5. Uploads artifacts to a **draft** release named after the tag. All three
   runners append to the same draft release.

When all three jobs succeed, go to the
[releases page](https://github.com/leodavinci1/kanbots/releases), open
the draft, write the changelog, and click **Publish**. Until you publish
it, the artifacts aren't reachable from
`releases/latest/download/<file>`.

You can also run the workflow manually from the Actions tab via
**Run workflow** and pass a version string (without the `v`).

## Artifact naming

Artifacts use a stable, predictable scheme so direct download links from
the marketing site keep working across versions:

| Platform | File | Notes |
| --- | --- | --- |
| Linux x64 | `kanbots-<version>-linux-x64.AppImage` | Make executable: `chmod +x kanbots-<v>-linux-x64.AppImage`. |
| Linux x64 | `kanbots-<version>-linux-x64.tar.xz` | Extract anywhere; run `./kanbots`. |
| macOS arm64 | `kanbots-<version>-mac-arm64.dmg` | Apple Silicon (M1+). |
| macOS arm64 | `kanbots-<version>-mac-arm64.zip` | For auto-update use; same payload as `.dmg`. |
| macOS x64 | `kanbots-<version>-mac-x64.dmg` | Intel Macs. |
| macOS x64 | `kanbots-<version>-mac-x64.zip` | For auto-update use; same payload as `.dmg`. |
| Windows x64 | `kanbots-<version>-win-x64.exe` | NSIS installer (recommended). |
| Windows x64 | `kanbots-<version>-win-x64.exe` | Portable build (different artifact ID). |

`releases/latest/download/<file>` resolves to the newest published
release, so the marketing site can hardcode these names.

## Unsigned builds — what users will see

We do not yet code-sign macOS or Windows builds (Apple Developer ID and
EV codesigning certificates are paid; we'll add them when revenue
covers it). The runtime impact:

### macOS

The exact Gatekeeper message depends on the macOS version:

- macOS 14 and earlier: _"kanbots cannot be opened because Apple cannot
  check it for malicious software."_ Bypassed by right-click → **Open**.
- macOS 15+ (incl. macOS 26 / Tahoe): _"kanbots is damaged and can't
  be opened. You should move it to the Trash."_ Right-click → **Open**
  no longer works on this wording; the only manual workaround is the
  `xattr` command below.

We ship a one-line installer to take the manual step off users'
plates — it downloads the latest .dmg and clears the quarantine flag
automatically:

```sh
curl -fsSL https://kanbots.dev/install-mac.sh | bash
```

Source: [`marketing/public/install-mac.sh`](https://kanbots.dev/install-mac.sh)
(canonical copy lives in the `kanbots-marketing` repo, served by Vercel).

Users who prefer a manual install:

1. Right-click the app, choose **Open**, then click **Open** again
   (only works on macOS 14 and earlier).
2. From a terminal:
   ```sh
   xattr -dr com.apple.quarantine "/Applications/kanbots.app"
   ```

### Windows

> Microsoft Defender SmartScreen prevented an unrecognized app from
> starting.

The user clicks **More info** → **Run anyway**.

We document both flows in
[`docs/getting-started.md`](getting-started.md) so users know what to
expect.

### Future: signing & notarization

When we sign:

- **macOS**: Apple Developer ID + notarization. Set
  `CSC_LINK` (Developer ID Application certificate as base64),
  `CSC_KEY_PASSWORD`, plus `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` /
  `APPLE_TEAM_ID` for notarization. Remove the
  `CSC_IDENTITY_AUTO_DISCOVERY: "false"` env var from the workflow.
- **Windows**: EV code-signing certificate. Set `CSC_LINK` and
  `CSC_KEY_PASSWORD` similarly. EV certs warm up SmartScreen reputation
  immediately; non-EV certs build reputation over time.

## Auto-update

The `publish: github` block in `packages/desktop/package.json` makes
electron-builder emit `latest-mac.yml`, `latest-linux.yml`, and
`latest.yml` alongside the binaries. To enable auto-update we'd wire up
`electron-updater` in `packages/desktop/src/main.ts`. Not done yet — the
v1 flow is "user downloads new release manually."

## What if the workflow fails?

Each runner uploads its `release/*` directory as a workflow artifact
(retained 14 days), even on failure. Open the failed job, download the
artifact, inspect locally. Common breakers:

- **better-sqlite3 prebuild missing for Electron `<x>`** — bump
  `electron` to a version with prebuilt `better-sqlite3` binaries, or
  pin `better-sqlite3` to a version that has prebuilds for the current
  Electron.
- **macOS x64 build fails on macos-latest (arm64 host)** — Apple Silicon
  runners cross-build x64 .dmgs; if an upstream tool starts requiring
  Rosetta, install it explicitly:
  `softwareupdate --install-rosetta --agree-to-license`.
- **electron-builder can't find a draft release to attach to** — usually
  means `GH_TOKEN` is missing or the tag isn't on the same branch as the
  workflow run. The workflow uses `secrets.GITHUB_TOKEN` which has
  `contents: write` per the `permissions:` block.
