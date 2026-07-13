/**
 * Domain types for an evaluation result (R7). These describe the normalized,
 * aggregated shape the API returns. The Zod schema that validates the raw LLM
 * response is derived from the rubric at runtime (see `src/rubric/`), so it is
 * not declared here.
 */

/** A literal excerpt cited from the conversation, anchored to a message index. */
export interface Evidence {
  messageIndex: number;
  quote: string;
}

/** Result for a single rubric dimension. A `null` score means there was
 * insufficient data to score it, and the dimension is excluded from the
 * weighted average. */
export interface DimensionResult {
  dimensionId: string;
  score: number | null;
  justification: string;
  evidence: Evidence[];
}

/** Result for a single rubric flag. */
export interface FlagResult {
  flagId: string;
  triggered: boolean;
  justification: string;
  evidence: Evidence[];
}

/** Full evaluation result after deterministic aggregation. `overallScore` is
 * `null` when every dimension came back with a `null` score. */
export interface EvaluationResult {
  dimensions: DimensionResult[];
  flags: FlagResult[];
  overallScore: number | null;
  summary: string;
}

/** Metadata attached to the response and the audit trail (R7/R8). Fields are
 * populated across layers (orchestrator, cost calculation, persistence). */
export interface EvaluationMetadata {
  evaluationId: string;
  rubricId: string;
  rubricVersion: number;
  promptVersion: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  truncated: boolean;
  omittedMessageCount?: number;
  createdAt: string;
}
