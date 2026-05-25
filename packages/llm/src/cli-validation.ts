import { createCliEnvironment, resolveCommandOnPath } from '@kanbots/dispatcher';
import type { ValidateResult } from './types.js';

export function validateCliExecutable(label: string, command: string): ValidateResult {
  const env = createCliEnvironment();
  if (resolveCommandOnPath(command, env) !== null) {
    return { ok: true };
  }
  const path = env.PATH ?? env.Path ?? '';
  return {
    ok: false,
    error:
      `${label} executable \`${command}\` was not found on PATH. ` +
      'Install the CLI or launch Kanbots after your shell PATH is available. ' +
      `Current PATH: ${path || '(empty)'}`,
  };
}
