#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const desktopRoot = resolve(__dirname, '..');

const electronVersion = require('electron/package.json').version;
const sqlitePkgPath = require.resolve('better-sqlite3/package.json', { paths: [desktopRoot] });
const sqliteDir = dirname(sqlitePkgPath);
const sqliteVersion = require(sqlitePkgPath).version;
const binPath = join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');
const prebuildInstall = require.resolve('prebuild-install/bin.js', { paths: [sqliteDir] });

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const targetPlatform = args.platform ?? process.platform;
const targetArch = args.arch ?? process.arch;
const targetRuntime = args.runtime ?? 'electron';

if (targetRuntime !== 'electron' && targetRuntime !== 'node') {
  console.error(`[ensure-native] unsupported runtime: ${targetRuntime}`);
  process.exit(1);
}

const targetVersion = targetRuntime === 'electron' ? electronVersion : process.versions.node;

function fingerprint() {
  const binHash = existsSync(binPath)
    ? createHash('sha256').update(readFileSync(binPath)).digest('hex')
    : 'missing';
  return [
    `${targetRuntime}@${targetVersion}`,
    `better-sqlite3@${sqliteVersion}`,
    targetPlatform,
    targetArch,
    `bin:${binHash}`,
  ].join(' ');
}

const marker = join(sqliteDir, `.kanbots-${targetRuntime}-rebuild`);
const markers = [
  join(sqliteDir, '.kanbots-electron-rebuild'),
  join(sqliteDir, '.kanbots-node-rebuild'),
];

if (existsSync(marker) && readFileSync(marker, 'utf-8').trim() === fingerprint()) {
  process.exit(0);
}

console.log(
  `[ensure-native] fetching better-sqlite3 prebuild for ${targetRuntime} ${targetVersion} (${targetPlatform}/${targetArch})…`,
);

// Unlink the existing binary and marker before prebuild-install rewrites them.
// prebuild-install extracts via tar streams that open files with O_TRUNC, which
// would mutate any pre-existing hard link in place — including one that
// electron-builder already created inside a packaged .app dir (release/mac-arm64).
// Breaking the source-side link first keeps prior .app dirs pinned to the OLD
// inode/content. Without this, packing arm64 then x64 leaves both .apps with the
// x64 binary because the marker+binary inodes are shared via hard link.
for (const p of [binPath, ...markers]) {
  try {
    unlinkSync(p);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

const result = spawnSync(
  process.execPath,
  [
    prebuildInstall,
    `--runtime=${targetRuntime}`,
    `--target=${targetVersion}`,
    `--arch=${targetArch}`,
    `--platform=${targetPlatform}`,
  ],
  { cwd: sqliteDir, stdio: 'inherit' },
);

if (result.status !== 0) {
  console.error('[ensure-native] prebuild-install failed');
  process.exit(result.status ?? 1);
}

writeFileSync(marker, fingerprint(), 'utf-8');
console.log('[ensure-native] better-sqlite3 ready');
