const DEFER_TO_CLI_MODEL_IDS = new Set(['default']);

export function resolveExplicitModel(model: string | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed || DEFER_TO_CLI_MODEL_IDS.has(trimmed)) return null;
  return trimmed;
}

export function appendModelArg(args: string[], flag: string, model: string | undefined): void {
  const explicit = resolveExplicitModel(model);
  if (explicit !== null) {
    args.push(flag, explicit);
  }
}
