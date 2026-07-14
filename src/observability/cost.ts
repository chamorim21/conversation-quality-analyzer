import { getPricing } from '../config/pricing.js';

/**
 * Estimated USD cost of an evaluation from its token usage and the pricing
 * table. Returns 0 for a model with no known price rather than guessing, so an
 * unknown model never fabricates a cost.
 */
export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = getPricing(model);
  if (!pricing) return 0;
  return tokensIn * pricing.inputPerToken + tokensOut * pricing.outputPerToken;
}
