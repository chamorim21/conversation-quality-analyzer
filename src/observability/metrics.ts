import type { EvaluationMetricsData } from '../persistence/repository.js';

/** Per-dimension score statistics within one rubric version. */
export interface DimensionScoreStats {
  /** Number of evaluations that produced a numeric score for this dimension. */
  scored: number;
  /** Number that came back `insufficient_data` (null score). */
  insufficient: number;
  /** Mean of the numeric scores, or null when none were scored. */
  average: number | null;
  /** Histogram of scores by value ("0".."5"). */
  distribution: Record<string, number>;
}

/** Aggregated operational metrics served by `GET /metrics` (R10). */
export interface MetricsSummary {
  totalEvaluations: number;
  errorCount: number;
  errorRate: number;
  cost: { totalUsd: number; averageUsd: number };
  tokens: { totalIn: number; totalOut: number };
  latencyMs: { p50: number; p95: number };
  /** Flag id → number of evaluations where it was triggered. */
  flags: Record<string, number>;
  /** `rubricId@version` → dimensionId → score statistics. */
  scoresByRubric: Record<string, Record<string, DimensionScoreStats>>;
}

/**
 * Nearest-rank percentile (`p` in 0–100). Returns 0 for an empty set. Copies
 * before sorting so the caller's array is left untouched. Deterministic and
 * simple, which keeps the metric easy to reason about and to test.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length); // 1-based
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

function emptyDimensionStats(): DimensionScoreStats {
  return { scored: 0, insufficient: 0, average: null, distribution: {} };
}

/**
 * Derives the {@link MetricsSummary} from the raw data gathered by the
 * repository. Pure (no I/O), so it is unit-tested with hand-built inputs. Score
 * distributions and flag counts come from the persisted result of every
 * successful evaluation, grouped by the rubric version that produced them.
 */
export function computeMetrics(data: EvaluationMetricsData): MetricsSummary {
  const { total, errors } = data;

  const flags: Record<string, number> = {};
  const scoreSums = new Map<string, Map<string, number>>(); // for averages
  const scoresByRubric: Record<string, Record<string, DimensionScoreStats>> = {};

  for (const { rubricId, rubricVersion, result } of data.successResults) {
    const rubricKey = `${rubricId}@${rubricVersion}`;
    const byDimension = (scoresByRubric[rubricKey] ??= {});
    const sumsByDimension = scoreSums.get(rubricKey) ?? new Map<string, number>();
    scoreSums.set(rubricKey, sumsByDimension);

    for (const dimension of result.dimensions) {
      const stats = (byDimension[dimension.dimensionId] ??= emptyDimensionStats());
      if (dimension.score === null) {
        stats.insufficient += 1;
      } else {
        stats.scored += 1;
        const bucket = String(dimension.score);
        stats.distribution[bucket] = (stats.distribution[bucket] ?? 0) + 1;
        sumsByDimension.set(
          dimension.dimensionId,
          (sumsByDimension.get(dimension.dimensionId) ?? 0) + dimension.score,
        );
      }
    }

    for (const flag of result.flags) {
      if (flag.triggered) {
        flags[flag.flagId] = (flags[flag.flagId] ?? 0) + 1;
      }
    }
  }

  // Finalize averages now that every dimension's scored count and sum are known.
  for (const [rubricKey, byDimension] of Object.entries(scoresByRubric)) {
    const sums = scoreSums.get(rubricKey);
    for (const [dimensionId, stats] of Object.entries(byDimension)) {
      const sum = sums?.get(dimensionId) ?? 0;
      stats.average = stats.scored > 0 ? sum / stats.scored : null;
    }
  }

  return {
    totalEvaluations: total,
    errorCount: errors,
    errorRate: total > 0 ? errors / total : 0,
    cost: {
      totalUsd: data.totalCostUsd,
      averageUsd: total > 0 ? data.totalCostUsd / total : 0,
    },
    tokens: { totalIn: data.totalTokensIn, totalOut: data.totalTokensOut },
    latencyMs: {
      p50: percentile(data.latenciesMs, 50),
      p95: percentile(data.latenciesMs, 95),
    },
    flags,
    scoresByRubric,
  };
}
