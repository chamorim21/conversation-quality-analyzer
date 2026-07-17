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
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.6-terra': { input: 2.5, output: 15.0 },
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
