import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetPricingOverridesForTest,
  computeCostUsd,
  getModelPricing,
  MODEL_PRICING,
} from '../src/pricing.js';

describe('pricing', () => {
  afterEach(() => {
    delete process.env.KANBOTS_PRICING_OVERRIDES;
    _resetPricingOverridesForTest();
  });

  it('returns null cost for unknown models so rollups stay clean', () => {
    expect(computeCostUsd('not-a-real-model', { input: 1000, output: 1000 })).toBeNull();
    expect(computeCostUsd(null, { input: 1000, output: 1000 })).toBeNull();
    expect(computeCostUsd(undefined, { input: 1000, output: 1000 })).toBeNull();
  });

  it('computes gpt-5 cost from per-Mtok rates', () => {
    // gpt-5: $1.25/Mtok input, $10/Mtok output
    // 1M input + 500k output → $1.25 + $5 = $6.25
    const cost = computeCostUsd('gpt-5', { input: 1_000_000, output: 500_000 });
    expect(cost).toBeCloseTo(6.25, 5);
  });

  it('computes costs for Codex normalized model ids', () => {
    expect(computeCostUsd('gpt-5.5', { input: 1_000_000, output: 500_000 })).toBeCloseTo(6.25, 5);
    expect(computeCostUsd('gpt-5.4-mini', { input: 1_000_000, output: 500_000 })).toBeCloseTo(
      1.25,
      5,
    );
  });

  it('discounts cached input tokens at the cached rate', () => {
    // gpt-5: $1.25/Mtok billable input, $0.125/Mtok cached input, $10/Mtok output
    // 1M total input (200k cached, 800k billable), 0 output
    // = (800k/1M)*1.25 + (200k/1M)*0.125 = 1.0 + 0.025 = $1.025
    const cost = computeCostUsd('gpt-5', { input: 1_000_000, output: 0, cachedInput: 200_000 });
    expect(cost).toBeCloseTo(1.025, 5);
  });

  it('falls back to input rate when no cached rate is defined', () => {
    // claude-haiku-4-5 has no cachedInputUsdPerMtok field; cached should bill at input rate.
    // 1M input (all cached), 0 output → $1 (full input rate).
    const cost = computeCostUsd('claude-haiku-4-5', {
      input: 1_000_000,
      output: 0,
      cachedInput: 1_000_000,
    });
    expect(cost).toBeCloseTo(1, 5);
  });

  it('applies env overrides on top of the static table', () => {
    process.env.KANBOTS_PRICING_OVERRIDES = JSON.stringify({
      'gpt-5': { inputUsdPerMtok: 2, outputUsdPerMtok: 10 },
    });
    _resetPricingOverridesForTest();
    const cost = computeCostUsd('gpt-5', { input: 1_000_000, output: 0 });
    expect(cost).toBeCloseTo(2, 5);
  });

  it('ignores malformed overrides gracefully', () => {
    process.env.KANBOTS_PRICING_OVERRIDES = '{not valid json';
    _resetPricingOverridesForTest();
    // Should fall back to the static table without throwing.
    const cost = computeCostUsd('gpt-5', { input: 1_000_000, output: 0 });
    expect(cost).toBeCloseTo(1.25, 5);
  });

  it('exposes asOf date on every catalogued price for staleness lints', () => {
    for (const [id, price] of Object.entries(MODEL_PRICING)) {
      expect(price.asOf, `model ${id} missing asOf`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('getModelPricing returns the entry or null', () => {
    expect(getModelPricing('gpt-5')?.inputUsdPerMtok).toBe(1.25);
    expect(getModelPricing('not-a-model')).toBeNull();
  });
});
