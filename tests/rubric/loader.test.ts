import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRubrics, RubricNotFoundError } from '../../src/rubric/loader.js';

const VALID_RUBRIC = `
id: sample
version: 1
dimensions:
  - id: only_dimension
    name: Única
    description: Dimensão única de teste.
    weight: 1.0
    anchors:
      "0": zero
      "1": um
      "2": dois
      "3": três
      "4": quatro
      "5": cinco
flags:
  - id: some_flag
    description: Uma flag de teste.
`;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubrics-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

describe('loadRubrics', () => {
  it('loads a valid rubric and indexes it by id@version', () => {
    write('sample.v1.yaml', VALID_RUBRIC);
    const registry = loadRubrics(dir);

    expect(registry.list()).toEqual(['sample@1']);
    expect(registry.has('sample@1')).toBe(true);
    expect(registry.get('sample@1').id).toBe('sample');
  });

  it('resolves a bare id to the most recent version', () => {
    write('sample.v1.yaml', VALID_RUBRIC);
    write('sample.v2.yaml', VALID_RUBRIC.replace('version: 1', 'version: 2'));
    const registry = loadRubrics(dir);

    expect(registry.list()).toEqual(['sample@1', 'sample@2']);
    expect(registry.get('sample').version).toBe(2);
  });

  it('throws RubricNotFoundError listing available rubrics', () => {
    write('sample.v1.yaml', VALID_RUBRIC);
    const registry = loadRubrics(dir);

    expect(() => registry.get('missing')).toThrow(RubricNotFoundError);
    try {
      registry.get('missing');
    } catch (error) {
      expect((error as RubricNotFoundError).available).toEqual(['sample@1']);
    }
  });

  it('fails fast when dimension weights do not sum to 1.0', () => {
    write(
      'bad.yaml',
      VALID_RUBRIC.replace('id: sample', 'id: bad').replace('weight: 1.0', 'weight: 0.5'),
    );
    expect(() => loadRubrics(dir)).toThrow(/weights must sum to 1\.0/);
  });

  it('fails fast on duplicate dimension ids', () => {
    write(
      'dup.yaml',
      `
id: dup
version: 1
dimensions:
  - id: repeated
    name: A
    description: A.
    weight: 0.5
    anchors: { "0": z, "1": o, "2": d, "3": t, "4": q, "5": c }
  - id: repeated
    name: B
    description: B.
    weight: 0.5
    anchors: { "0": z, "1": o, "2": d, "3": t, "4": q, "5": c }
`,
    );
    expect(() => loadRubrics(dir)).toThrow(/duplicate dimension id: repeated/);
  });

  it('fails fast when an anchor level is missing', () => {
    write(
      'missing-anchor.yaml',
      `
id: incomplete
version: 1
dimensions:
  - id: d1
    name: A
    description: A.
    weight: 1.0
    anchors: { "0": z, "1": o, "2": d, "3": t, "4": q }
`,
    );
    expect(() => loadRubrics(dir)).toThrow(/Invalid rubric/);
  });

  it('fails fast on invalid YAML', () => {
    write('broken.yaml', 'id: broken\n  : : :\n');
    expect(() => loadRubrics(dir)).toThrow(/Invalid YAML in broken\.yaml/);
  });

  it('throws on duplicate id@version across files', () => {
    write('a.yaml', VALID_RUBRIC);
    write('b.yaml', VALID_RUBRIC);
    expect(() => loadRubrics(dir)).toThrow(/Duplicate rubric sample@1/);
  });
});
