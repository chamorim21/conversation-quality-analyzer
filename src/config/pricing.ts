/** A model's price, in USD per token. */
export interface ModelPricing {
  inputPerToken: number;
  outputPerToken: number;
}

/**
 * Public OpenAI prices in USD per 1 million tokens. Kept here, versioned, for
 * the per-evaluation cost calculation. Update when OpenAI changes the table.
 */
const PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
};

/** Pricing table normalized to USD per token. */
export const PRICING: Record<string, ModelPricing> = Object.fromEntries(
  Object.entries(PER_MILLION_TOKENS).map(([model, price]) => [
    model,
    {
      inputPerToken: price.input / 1_000_000,
      outputPerToken: price.output / 1_000_000,
    },
  ]),
);

/** Returns a model's pricing, or `undefined` if it is not in the table. */
export function getPricing(model: string): ModelPricing | undefined {
  return PRICING[model];
}
