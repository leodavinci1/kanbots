// Per-model token pricing used to compute total_cost_usd for providers that
// emit token counts but no cost (currently codex). Anthropic's stream-json
// already carries `total_cost_usd` so claude-code does not consult this table.
//
// Prices are USD per 1M input/output tokens. Verify against vendor pricing
// pages before relying on rollups; an `asOf` date is attached to each entry
// so a future lint/CI check can flag stale data.
//
// Override at runtime with:
//   KANBOTS_PRICING_OVERRIDES='{"gpt-5":{"inputUsdPerMtok":1.0,"outputUsdPerMtok":8.0}}'
// The override is parsed once on first use and merged on top of the static
// table.

export interface ModelPricing {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  /** Cached input token rate for providers that report a cached/cacheable
   *  bucket separately (currently codex). */
  cachedInputUsdPerMtok?: number;
  /** ISO date the prices were last verified. Used by analytics to surface
   *  stale-pricing warnings. */
  asOf: string;
  source?: string;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // Anthropic Claude Code subscription. claude-code reports its own cost
  // directly so these are reference values; analytics that cross-check claude
  // self-reported cost can use them.
  'claude-opus-4-7': {
    inputUsdPerMtok: 15,
    outputUsdPerMtok: 75,
    asOf: '2026-05-05',
    source: 'https://www.anthropic.com/pricing',
  },
  'claude-sonnet-4-6': {
    inputUsdPerMtok: 3,
    outputUsdPerMtok: 15,
    asOf: '2026-05-05',
    source: 'https://www.anthropic.com/pricing',
  },
  'claude-haiku-4-5': {
    inputUsdPerMtok: 1,
    outputUsdPerMtok: 5,
    asOf: '2026-05-05',
    source: 'https://www.anthropic.com/pricing',
  },
  // OpenAI GPT-5 family — used by codex-cli. These drive the actual cost
  // computation since codex emits tokens but no cost.
  'gpt-5': {
    inputUsdPerMtok: 1.25,
    outputUsdPerMtok: 10,
    cachedInputUsdPerMtok: 0.125,
    asOf: '2026-05-05',
    source: 'https://platform.openai.com/docs/pricing',
  },
  'gpt-5-mini': {
    inputUsdPerMtok: 0.25,
    outputUsdPerMtok: 2,
    cachedInputUsdPerMtok: 0.025,
    asOf: '2026-05-05',
    source: 'https://platform.openai.com/docs/pricing',
  },
  // Cursor Agent CLI (`--model auto` / stream model "Auto"). Cursor Pro
  // burns an included pool, not API invoices — these Sonnet-class rates are
  // an API-equivalent estimate so KanBots meters aren't stuck at $0.00.
  // Prefer Hub Cursor % for true plan burn.
  auto: {
    inputUsdPerMtok: 3,
    outputUsdPerMtok: 15,
    cachedInputUsdPerMtok: 0.3,
    asOf: '2026-11-08',
    source: 'estimate: Claude Sonnet-class proxy for Cursor Auto included pool',
  },
  Auto: {
    inputUsdPerMtok: 3,
    outputUsdPerMtok: 15,
    cachedInputUsdPerMtok: 0.3,
    asOf: '2026-11-08',
    source: 'estimate: Claude Sonnet-class proxy for Cursor Auto included pool',
  },
});

let overrideCache: Record<string, ModelPricing> | null = null;
let overrideLoaded = false;

function loadOverrides(): Record<string, ModelPricing> {
  if (overrideLoaded) return overrideCache ?? {};
  overrideLoaded = true;
  const raw = typeof process !== 'undefined' ? process.env.KANBOTS_PRICING_OVERRIDES : undefined;
  if (!raw) {
    overrideCache = {};
    return overrideCache;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ModelPricing>>;
    const out: Record<string, ModelPricing> = {};
    for (const [id, partial] of Object.entries(parsed)) {
      if (
        typeof partial.inputUsdPerMtok !== 'number' ||
        typeof partial.outputUsdPerMtok !== 'number'
      ) {
        continue;
      }
      out[id] = {
        inputUsdPerMtok: partial.inputUsdPerMtok,
        outputUsdPerMtok: partial.outputUsdPerMtok,
        ...(typeof partial.cachedInputUsdPerMtok === 'number'
          ? { cachedInputUsdPerMtok: partial.cachedInputUsdPerMtok }
          : {}),
        asOf: partial.asOf ?? new Date().toISOString().slice(0, 10),
        ...(partial.source ? { source: partial.source } : {}),
      };
    }
    overrideCache = out;
  } catch {
    overrideCache = {};
  }
  return overrideCache;
}

export function getModelPricing(modelId: string): ModelPricing | null {
  const overrides = loadOverrides();
  if (overrides[modelId]) return overrides[modelId]!;
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId]!;
  // Cursor reports "Auto"; CLI flag is often "auto".
  const lower = modelId.toLowerCase();
  return overrides[lower] ?? MODEL_PRICING[lower] ?? null;
}

export interface TokenUsage {
  input: number;
  output: number;
  /** Cached input tokens (codex only). When provided, billed at the
   *  cached rate if the model has one defined. */
  cachedInput?: number;
}

/**
 * Compute USD cost for a single turn given a model and token usage. Returns
 * null when the model is unknown — callers should leave totalCostUsd null in
 * that case rather than recording $0, which would corrupt rollups.
 */
export function computeCostUsd(modelId: string | null | undefined, usage: TokenUsage): number | null {
  if (!modelId) return null;
  const price = getModelPricing(modelId);
  if (!price) return null;
  const billableInput = Math.max(0, usage.input - (usage.cachedInput ?? 0));
  let cost =
    (billableInput / 1_000_000) * price.inputUsdPerMtok +
    (usage.output / 1_000_000) * price.outputUsdPerMtok;
  if (typeof usage.cachedInput === 'number' && usage.cachedInput > 0) {
    const cachedRate = price.cachedInputUsdPerMtok ?? price.inputUsdPerMtok;
    cost += (usage.cachedInput / 1_000_000) * cachedRate;
  }
  return cost;
}

/** Test seam: clears the env override cache. */
export function _resetPricingOverridesForTest(): void {
  overrideCache = null;
  overrideLoaded = false;
}
