import { describe, it, expect } from 'vitest';
import { parseRubric, type RubricDimension } from '../../src/rubric/schema.js';
import { buildResponseJsonSchema } from '../../src/rubric/json-schema.js';
import { buildResponseValidator } from '../../src/evaluation/orchestrator.js';

/**
 * The LLM response contract is expressed twice: as a JSON Schema sent to OpenAI
 * (`rubric/json-schema.ts`) and as a Zod schema used to re-validate the reply
 * (`orchestrator.ts`). These tests build an instance whose field names come
 * straight from the generated JSON Schema and assert the Zod validator accepts
 * it, so the two definitions cannot silently drift apart on field names or
 * required fields.
 */

function anchors(): RubricDimension['anchors'] {
  return { '0': 'z', '1': 'o', '2': 'd', '3': 't', '4': 'q', '5': 'c' };
}

const rubric = parseRubric({
  id: 'test',
  version: 1,
  dimensions: [
    { id: 'communication', name: 'C', description: 'c', weight: 0.5, anchors: anchors() },
    { id: 'resolution', name: 'R', description: 'r', weight: 0.5, anchors: anchors() },
  ],
  flags: [{ id: 'hallucination', description: 'h' }],
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

/** Builds a minimal evidence array using the field names declared in the JSON
 * Schema, so a rename on either side breaks the test. */
function evidenceFromSchema(evidenceSchema: Obj): Obj[] {
  const item: Obj = {};
  for (const key of evidenceSchema.items.required as string[]) {
    item[key] = key === 'message_index' ? 0 : 'x';
  }
  return [item];
}

/** Builds a fully-valid response instance driven entirely by the generated JSON
 * Schema's `required` lists and property keys. */
function instanceFromSchema(schema: Obj): Obj {
  const dimSchema = schema.properties.dimensions;
  const dimensions: Obj = {};
  for (const id of dimSchema.required as string[]) {
    const props = dimSchema.properties[id];
    const obj: Obj = {};
    for (const key of props.required as string[]) {
      if (key === 'insufficient_data') obj[key] = false;
      else if (key === 'score') obj[key] = 3;
      else if (key === 'evidence') obj[key] = evidenceFromSchema(props.properties.evidence);
      else obj[key] = 'x';
    }
    dimensions[id] = obj;
  }

  const flagSchema = schema.properties.flags;
  const flags: Obj = {};
  for (const id of flagSchema.required as string[]) {
    const props = flagSchema.properties[id];
    const obj: Obj = {};
    for (const key of props.required as string[]) {
      if (key === 'triggered') obj[key] = false;
      else if (key === 'evidence') obj[key] = evidenceFromSchema(props.properties.evidence);
      else obj[key] = 'x';
    }
    flags[id] = obj;
  }

  return { dimensions, flags, summary: 'ok' };
}

describe('response contract: JSON Schema and Zod validator agree', () => {
  const validator = buildResponseValidator(rubric);
  const jsonSchema = buildResponseJsonSchema(rubric) as Obj;

  it('the Zod validator accepts an instance built from the generated JSON Schema', () => {
    expect(() => validator.parse(instanceFromSchema(jsonSchema))).not.toThrow();
  });

  it('rejects evidence field-name drift (message_index renamed)', () => {
    const instance = instanceFromSchema(jsonSchema);
    const evidence = instance.dimensions.communication.evidence[0];
    evidence.messageIndex = evidence.message_index;
    delete evidence.message_index;
    expect(() => validator.parse(instance)).toThrow();
  });

  it('rejects a missing required dimension field (insufficient_data)', () => {
    const instance = instanceFromSchema(jsonSchema);
    delete instance.dimensions.communication.insufficient_data;
    expect(() => validator.parse(instance)).toThrow();
  });

  it('rejects unknown extra keys, matching additionalProperties: false', () => {
    const instance = instanceFromSchema(jsonSchema);
    instance.dimensions.communication.unexpected = true;
    expect(() => validator.parse(instance)).toThrow();
  });
});
