import { describe, it, expect } from 'vitest';
import { parseRubric, type RubricDimension } from '../../src/rubric/schema.js';
import {
  aggregateEvaluation,
  computeOverallScore,
} from '../../src/evaluation/aggregate.js';
import type { DimensionResult } from '../../src/domain/evaluation.js';

function anchors(): RubricDimension['anchors'] {
  return { '0': 'z', '1': 'o', '2': 'd', '3': 't', '4': 'q', '5': 'c' };
}

function dimension(id: string, weight: number): RubricDimension {
  return { id, name: id, description: id, weight, anchors: anchors() };
}

function rubricWith(dimensions: RubricDimension[]) {
  return parseRubric({ id: 'test', version: 1, dimensions, flags: [] });
}

function scored(dimensionId: string, score: number | null): DimensionResult {
  return { dimensionId, score, justification: '', evidence: [] };
}

describe('computeOverallScore', () => {
  it('is the rubric-weighted average of the scored dimensions', () => {
    const rubric = rubricWith([
      dimension('a', 0.25),
      dimension('b', 0.25),
      dimension('c', 0.25),
      dimension('d', 0.25),
    ]);
    const score = computeOverallScore(rubric, [
      scored('a', 4),
      scored('b', 2),
      scored('c', 5),
      scored('d', 1),
    ]);
    // (4 + 2 + 5 + 1) / 4 = 3
    expect(score).toBe(3);
  });

  it('honours unequal weights', () => {
    const rubric = rubricWith([dimension('a', 0.75), dimension('b', 0.25)]);
    const score = computeOverallScore(rubric, [scored('a', 4), scored('b', 0)]);
    // 4 * 0.75 + 0 * 0.25 = 3
    expect(score).toBe(3);
  });

  it('drops insufficient_data dimensions and renormalizes the remaining weights', () => {
    const rubric = rubricWith([
      dimension('a', 0.25),
      dimension('b', 0.25),
      dimension('c', 0.25),
      dimension('d', 0.25),
    ]);
    const score = computeOverallScore(rubric, [
      scored('a', 4),
      scored('b', 2),
      scored('c', null),
      scored('d', null),
    ]);
    // only a and b count, weights renormalized to 0.5 each: (4 + 2) / 2 = 3
    expect(score).toBe(3);
  });

  it('returns null when every dimension is insufficient_data', () => {
    const rubric = rubricWith([dimension('a', 0.5), dimension('b', 0.5)]);
    expect(computeOverallScore(rubric, [scored('a', null), scored('b', null)])).toBeNull();
  });

  it('rounds to two decimals', () => {
    const rubric = rubricWith([
      dimension('a', 1 / 3),
      dimension('b', 1 / 3),
      dimension('c', 1 / 3),
    ]);
    const score = computeOverallScore(rubric, [
      scored('a', 5),
      scored('b', 4),
      scored('c', 4),
    ]);
    // (5 + 4 + 4) / 3 = 4.333... -> 4.33
    expect(score).toBe(4.33);
  });
});

describe('aggregateEvaluation', () => {
  it('assembles the result with the computed overall score', () => {
    const rubric = rubricWith([dimension('a', 0.5), dimension('b', 0.5)]);
    const dimensions = [scored('a', 4), scored('b', 2)];
    const flags = [
      { flagId: 'hallucination', triggered: false, justification: '', evidence: [] },
    ];
    const result = aggregateEvaluation(rubric, {
      dimensions,
      flags,
      summary: 'resumo',
    });
    expect(result).toEqual({
      dimensions,
      flags,
      overallScore: 3,
      summary: 'resumo',
    });
  });
});
