/** A model's price, in USD per token. */
export interface ModelPricing {
  inputPerToken: number;
  outputPerToken: number;
}

/** A catalog entry for a supported model: public price plus context window. */
interface ModelSpec {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** Total context window in tokens (input + output). */
  contextWindow: number;
}

/**
 * Supported OpenAI models with public price (USD per 1M tokens) and context
 * window (tokens). Kept here, versioned, as the single source of truth for the
 * per-evaluation cost calculation and the budget-vs-window validation. Update
 * when OpenAI changes the table.
 *
 * Prices from the OpenAI pricing page (https://developers.openai.com/api/docs/
 * pricing); context windows from each model's page under
 * https://developers.openai.com/api/docs/models. Both retrieved 2026-07-17.
 * gpt-5.4-mini and gpt-5.4-nano: 400k window; gpt-5.6-terra: 1.05M window
 * (all with 128k max output).
 */
const MODEL_CATALOG: Record<string, ModelSpec> = {
  'gpt-5.4-nano': { input: 0.2, output: 1.25, contextWindow: 400_000 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, contextWindow: 400_000 },
  'gpt-5.6-terra': { input: 2.5, output: 15.0, contextWindow: 1_050_000 },
};

/**
 * Fixed token budget reserved, on top of `MAX_CONVERSATION_TOKENS`, for the
 * parts of a request that are not the conversation: the system prompt, the
 * rendered rubric, the structured-output JSON Schema, and the judge's response.
 * A conservative constant — measuring the real prompt overhead is a documented
 * future improvement.
 */
export const TOKEN_RESERVE = 8_000;

/** Pricing table normalized to USD per token, derived from the catalog. */
export const PRICING: Record<string, ModelPricing> = Object.fromEntries(
  Object.entries(MODEL_CATALOG).map(([model, spec]) => [
    model,
    {
      inputPerToken: spec.input / 1_000_000,
      outputPerToken: spec.output / 1_000_000,
    },
  ]),
);

/** Returns a model's pricing, or `undefined` if it is not in the catalog. */
export function getPricing(model: string): ModelPricing | undefined {
  return PRICING[model];
}

/** Returns a model's context window in tokens, or `undefined` if uncataloged. */
export function getContextWindow(model: string): number | undefined {
  return MODEL_CATALOG[model]?.contextWindow;
}

/**
 * Thrown when a model is not in the catalog, or when the configured
 * `MAX_CONVERSATION_TOKENS` plus {@link TOKEN_RESERVE} does not fit its context
 * window. Carries the list of known models so callers (the API) can surface it.
 */
export class UnsupportedModelError extends Error {
  constructor(
    public readonly model: string,
    public readonly available: string[],
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedModelError';
  }
}

/**
 * Validates that `model` is known and that its context window fits
 * `maxConversationTokens + TOKEN_RESERVE`. Throws {@link UnsupportedModelError}
 * otherwise. Used both at boot (for `DEFAULT_MODEL`, fail-fast) and per request
 * (for the effective model), before any LLM call.
 */
export function assertModelSupported(model: string, maxConversationTokens: number): void {
  const available = Object.keys(MODEL_CATALOG);
  const spec = MODEL_CATALOG[model];
  if (!spec) {
    throw new UnsupportedModelError(
      model,
      available,
      `Unknown model: ${model}. Available: ${available.join(', ')}`,
    );
  }
  const required = maxConversationTokens + TOKEN_RESERVE;
  if (required > spec.contextWindow) {
    throw new UnsupportedModelError(
      model,
      available,
      `Model ${model} cannot fit the configured budget: ` +
        `MAX_CONVERSATION_TOKENS (${maxConversationTokens}) + TOKEN_RESERVE ` +
        `(${TOKEN_RESERVE}) = ${required} exceeds its context window ` +
        `(${spec.contextWindow}).`,
    );
  }
}
