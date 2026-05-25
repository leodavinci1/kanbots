const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

const PLATFORM_NAMES = { darwin: 'darwin', linux: 'linux', win32: 'win32', mas: 'darwin' };

module.exports = async function afterPack(context) {
  const archName = ARCH_NAMES[context.arch];
  const platformName = PLATFORM_NAMES[context.electronPlatformName];

  if (!archName || !platformName || archName === 'universal') return;

  const script = resolve(__dirname, 'ensure-native.cjs');
  const result = spawnSync(
    process.execPath,
    [script, '--runtime=node', `--platform=${process.platform}`, `--arch=${process.arch}`],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) {
    throw new Error(
      `[after-pack] restore native Node binary failed after ${platformName}/${archName}`,
    );
  }
};
