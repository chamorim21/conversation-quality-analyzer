import { describe, it, expect } from 'vitest';
import {
  PRICING,
  TOKEN_RESERVE,
  UnsupportedModelError,
  assertModelSupported,
  getContextWindow,
  getPricing,
} from '../../src/config/models.js';

const CATALOG_MODELS = ['gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.6-terra'];

describe('model catalog', () => {
  it('lists the three supported models with pricing', () => {
    expect(Object.keys(PRICING).sort()).toEqual([...CATALOG_MODELS].sort());
  });

  it('exposes a positive context window for every model', () => {
    for (const model of CATALOG_MODELS) {
      expect(getContextWindow(model)).toBeGreaterThan(0);
    }
  });

  it('reserves a positive token budget', () => {
    expect(TOKEN_RESERVE).toBeGreaterThan(0);
  });

  it('every model fits at least the reserve within its window', () => {
    for (const model of CATALOG_MODELS) {
      expect(() => assertModelSupported(model, 0)).not.toThrow();
    }
  });
});

describe('getPricing', () => {
  it('derives per-token pricing for a known model', () => {
    expect(getPricing('gpt-5.4-mini')).toEqual({
      inputPerToken: 0.75 / 1_000_000,
      outputPerToken: 4.5 / 1_000_000,
    });
  });

  it('returns undefined for an unknown model', () => {
    expect(getPricing('gpt-nonexistent')).toBeUndefined();
  });
});

describe('assertModelSupported', () => {
  const window = getContextWindow('gpt-5.4-mini')!;

  it('passes at the exact limit (max + reserve === window)', () => {
    expect(() =>
      assertModelSupported('gpt-5.4-mini', window - TOKEN_RESERVE),
    ).not.toThrow();
  });

  it('throws one token above the limit, with all three numbers in the message', () => {
    const max = window - TOKEN_RESERVE + 1;
    let caught: unknown;
    try {
      assertModelSupported('gpt-5.4-mini', max);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedModelError);
    const message = (caught as UnsupportedModelError).message;
    expect(message).toContain(String(max));
    expect(message).toContain(String(TOKEN_RESERVE));
    expect(message).toContain(String(window));
  });

  it('throws for an unknown model, listing the catalog in available', () => {
    let caught: unknown;
    try {
      assertModelSupported('gpt-nonexistent', 1000);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedModelError);
    const err = caught as UnsupportedModelError;
    expect(err.model).toBe('gpt-nonexistent');
    expect(err.available.sort()).toEqual([...CATALOG_MODELS].sort());
  });
});
