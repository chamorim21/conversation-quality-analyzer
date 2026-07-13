import { z } from 'zod';

/** Score levels every dimension must define anchors for. */
export const ANCHOR_LEVELS = ['0', '1', '2', '3', '4', '5'] as const;

/** Rubric ids (of rubrics, dimensions, and flags) must be snake_case so they
 * can be used safely as JSON Schema property keys and enum values. */
const idField = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'must be a snake_case identifier');

/** Descriptive anchors for scores 0–5. Exactly these keys, no more, no less. */
const AnchorsSchema = z
  .object({
    '0': z.string().min(1),
    '1': z.string().min(1),
    '2': z.string().min(1),
    '3': z.string().min(1),
    '4': z.string().min(1),
    '5': z.string().min(1),
  })
  .strict();

export const RubricDimensionSchema = z.object({
  id: idField,
  name: z.string().min(1),
  description: z.string().min(1),
  weight: z.number().gt(0).max(1),
  anchors: AnchorsSchema,
});
export type RubricDimension = z.infer<typeof RubricDimensionSchema>;

export const RubricFlagSchema = z.object({
  id: idField,
  description: z.string().min(1),
});
export type RubricFlag = z.infer<typeof RubricFlagSchema>;

const WEIGHT_SUM_TOLERANCE = 1e-6;

function firstDuplicate(ids: string[]): string | undefined {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

export const RubricSchema = z
  .object({
    id: idField,
    version: z.number().int().positive(),
    dimensions: z.array(RubricDimensionSchema).min(1),
    flags: z.array(RubricFlagSchema).default([]),
  })
  .superRefine((rubric, ctx) => {
    const duplicateDimension = firstDuplicate(rubric.dimensions.map((d) => d.id));
    if (duplicateDimension) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions'],
        message: `duplicate dimension id: ${duplicateDimension}`,
      });
    }

    const duplicateFlag = firstDuplicate(rubric.flags.map((f) => f.id));
    if (duplicateFlag) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flags'],
        message: `duplicate flag id: ${duplicateFlag}`,
      });
    }

    const weightSum = rubric.dimensions.reduce((sum, d) => sum + d.weight, 0);
    if (Math.abs(weightSum - 1) > WEIGHT_SUM_TOLERANCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions'],
        message: `dimension weights must sum to 1.0 (got ${weightSum})`,
      });
    }
  });
export type Rubric = z.infer<typeof RubricSchema>;

/**
 * Validates a raw (parsed YAML) value against the rubric schema. Throws a clear,
 * aggregated error (fail-fast) when invalid; `source` is included in the message
 * to point at the offending file.
 */
export function parseRubric(raw: unknown, source?: string): Rubric {
  const result = RubricSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    const where = source ? ` (${source})` : '';
    throw new Error(`Invalid rubric${where}:\n${issues}`);
  }
  return result.data;
}
