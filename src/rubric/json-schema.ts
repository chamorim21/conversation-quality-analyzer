import type { Rubric } from './schema.js';

/** A JSON Schema object. Loosely typed on purpose — it is a plain data
 * structure handed to the OpenAI structured-output API. */
export type JsonSchema = Record<string, unknown>;

/**
 * Builds the JSON Schema for the LLM structured output from a rubric. The shape
 * is derived entirely from the rubric's dimensions and flags, so changing the
 * rubric changes the schema with no code change.
 *
 * The schema is OpenAI strict-mode compatible: every object sets
 * `additionalProperties: false` and lists every property in `required`, and it
 * uses only supported keywords (`type`, `properties`, `required`,
 * `additionalProperties`, `enum`, `items`, `anyOf`). Optionality (a `null`
 * score for `insufficient_data`) is expressed via a nullable union rather than
 * by omitting a required field.
 */
export function buildResponseJsonSchema(rubric: Rubric): JsonSchema {
  const dimensionProperties: Record<string, JsonSchema> = {};
  for (const dimension of rubric.dimensions) {
    dimensionProperties[dimension.id] = {
      type: 'object',
      additionalProperties: false,
      required: ['insufficient_data', 'score', 'justification', 'evidence'],
      properties: {
        insufficient_data: {
          type: 'boolean',
          description:
            'true quando não há evidência suficiente na conversa para pontuar esta dimensão.',
        },
        score: {
          anyOf: [
            { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
            { type: 'null' },
          ],
          description:
            'Nota inteira de 0 a 5 segundo as âncoras; null quando insufficient_data for true.',
        },
        justification: { type: 'string' },
        evidence: evidenceArraySchema(),
      },
    };
  }

  const flagProperties: Record<string, JsonSchema> = {};
  for (const flag of rubric.flags) {
    flagProperties[flag.id] = {
      type: 'object',
      additionalProperties: false,
      required: ['triggered', 'justification', 'evidence'],
      properties: {
        triggered: { type: 'boolean' },
        justification: { type: 'string' },
        evidence: evidenceArraySchema(),
      },
    };
  }

  return {
    type: 'object',
    additionalProperties: false,
    required: ['dimensions', 'flags', 'summary'],
    properties: {
      dimensions: {
        type: 'object',
        additionalProperties: false,
        required: rubric.dimensions.map((d) => d.id),
        properties: dimensionProperties,
      },
      flags: {
        type: 'object',
        additionalProperties: false,
        required: rubric.flags.map((f) => f.id),
        properties: flagProperties,
      },
      summary: {
        type: 'string',
        description: 'Resumo executivo da avaliação, em português.',
      },
    },
  };
}

/** Fresh evidence-array schema on each call so no object is shared between
 * branches of the generated schema. */
function evidenceArraySchema(): JsonSchema {
  return {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['message_index', 'quote'],
      properties: {
        message_index: {
          type: 'integer',
          description: 'Índice (0-based) da mensagem citada na conversa.',
        },
        quote: {
          type: 'string',
          description: 'Trecho literal citado da mensagem.',
        },
      },
    },
  };
}
