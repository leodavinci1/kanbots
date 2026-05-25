import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliEnvironment, mergePathValues, resolveCommandOnPath } from '../src/cli-env.js';

let tmp: string | null = null;

afterEach(async () => {
  if (tmp === null) return;
  await rm(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('cli-env', () => {
  it('dedupes merged PATH entries while preserving order', () => {
    expect(mergePathValues(['/a', '/b'].join(delimiter), ['/b', '/c'].join(delimiter))).toBe(
      ['/a', '/b', '/c'].join(delimiter),
    );
  });

  it('resolves executables from an explicit PATH', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kanbots-cli-env-'));
    const bin = join(tmp, 'fake-cli');
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(bin, 0o755);

    const env = createCliEnvironment({ PATH: tmp });
    expect(resolveCommandOnPath('fake-cli', env)).toBe(bin);
    expect(resolveCommandOnPath('missing-cli', env)).toBeNull();
  });
});
