import { describe, it, expect } from 'vitest';
import { parseRubric, type RubricDimension } from '../../src/rubric/schema.js';
import { buildResponseJsonSchema } from '../../src/rubric/json-schema.js';

function anchors(): RubricDimension['anchors'] {
  return { '0': 'z', '1': 'o', '2': 'd', '3': 't', '4': 'q', '5': 'c' };
}

const baseDimension: RubricDimension = {
  id: 'communication',
  name: 'Comunicação',
  description: 'Clareza das mensagens.',
  weight: 1.0,
  anchors: anchors(),
};

function rubricWith(dimensions: RubricDimension[]) {
  return parseRubric({
    id: 'test',
    version: 1,
    dimensions,
    flags: [{ id: 'hallucination', description: 'inventa informação' }],
  });
}

/** Recursively asserts the OpenAI strict-mode invariants: every object sets
 * additionalProperties:false and lists every declared property in `required`. */
function assertStrict(schema: Record<string, unknown>): void {
  if (schema.type === 'object') {
    expect(schema.additionalProperties).toBe(false);
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const required = (schema.required ?? []) as string[];
    expect([...required].sort()).toEqual(Object.keys(properties).sort());
    for (const value of Object.values(properties)) {
      assertStrict(value as Record<string, unknown>);
    }
  }
  if (schema.type === 'array' && schema.items) {
    assertStrict(schema.items as Record<string, unknown>);
  }
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) {
      assertStrict(branch as Record<string, unknown>);
    }
  }
}

describe('buildResponseJsonSchema', () => {
  it('produces a strict-mode compatible schema (recursively)', () => {
    const schema = buildResponseJsonSchema(rubricWith([baseDimension]));
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect((schema.required as string[]).sort()).toEqual([
      'dimensions',
      'flags',
      'summary',
    ]);
    assertStrict(schema);
  });

  it('keys dimensions and flags by their rubric ids', () => {
    const schema = buildResponseJsonSchema(rubricWith([baseDimension]));
    const properties = schema.properties as Record<string, any>;
    expect(Object.keys(properties.dimensions.properties)).toEqual(['communication']);
    expect(properties.dimensions.required).toEqual(['communication']);
    expect(Object.keys(properties.flags.properties)).toEqual(['hallucination']);
  });

  it('models score as a nullable integer enum 0..5', () => {
    const schema = buildResponseJsonSchema(rubricWith([baseDimension]));
    const properties = schema.properties as Record<string, any>;
    const score = properties.dimensions.properties.communication.properties.score;
    expect(score.anyOf).toEqual([
      { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
      { type: 'null' },
    ]);
  });

  it('a new dimension added to the rubric appears in the schema without code change', () => {
    const schema = buildResponseJsonSchema(
      rubricWith([
        { ...baseDimension, weight: 0.5 },
        {
          id: 'tone_quality',
          name: 'Qualidade do tom',
          description: 'Tom cordial.',
          weight: 0.5,
          anchors: anchors(),
        },
      ]),
    );
    const dimensions = (schema.properties as Record<string, any>).dimensions;
    expect(Object.keys(dimensions.properties)).toContain('tone_quality');
    expect(dimensions.required).toContain('tone_quality');
  });
});
