import { getPricing } from '../config/models.js';

/**
 * Estimated USD cost of an evaluation from its token usage and the pricing
 * table. The 0 fallback for a model with no known price is a defensive guard:
 * boot and per-request validation reject unknown models before any evaluation
 * runs, so no normal request reaches this path with an uncataloged model.
 */
export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = getPricing(model);
  if (!pricing) return 0;
  return tokensIn * pricing.inputPerToken + tokensOut * pricing.outputPerToken;
}
