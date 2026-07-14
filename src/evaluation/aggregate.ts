import type {
  DimensionResult,
  EvaluationResult,
  FlagResult,
} from '../domain/evaluation.js';
import type { Rubric } from '../rubric/schema.js';

/** Rounds to two decimals so the overall score is stable and readable. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Computes the overall score as the rubric-weighted average of the scored
 * dimensions (R6). Dimensions that came back `insufficient_data` (a `null`
 * score) are dropped and the remaining weights are renormalized, so a missing
 * dimension neither counts as zero nor skews the others. Returns `null` when
 * every dimension is `insufficient_data`.
 */
export function computeOverallScore(
  rubric: Rubric,
  dimensions: DimensionResult[],
): number | null {
  const weightById = new Map(rubric.dimensions.map((d) => [d.id, d.weight]));

  let weightedSum = 0;
  let includedWeight = 0;
  for (const dimension of dimensions) {
    if (dimension.score === null) continue;
    const weight = weightById.get(dimension.dimensionId);
    if (weight === undefined) continue; // not part of this rubric; ignore
    weightedSum += dimension.score * weight;
    includedWeight += weight;
  }

  if (includedWeight === 0) return null;
  return round2(weightedSum / includedWeight);
}

/**
 * Assembles the final {@link EvaluationResult} from the per-dimension and
 * per-flag results plus the executive summary, computing the overall score
 * deterministically from the rubric weights.
 */
export function aggregateEvaluation(
  rubric: Rubric,
  parts: {
    dimensions: DimensionResult[];
    flags: FlagResult[];
    summary: string;
  },
): EvaluationResult {
  return {
    dimensions: parts.dimensions,
    flags: parts.flags,
    overallScore: computeOverallScore(rubric, parts.dimensions),
    summary: parts.summary,
  };
}
