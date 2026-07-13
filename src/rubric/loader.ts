import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseRubric, type Rubric } from './schema.js';

/** Default directory holding the rubric YAML files, relative to the process
 * working directory (the project root when the app runs). */
export const DEFAULT_RUBRICS_DIR = path.resolve(process.cwd(), 'rubrics');

/** Thrown when a requested rubric selector cannot be resolved. Carries the list
 * of available selectors so callers (the API) can surface it in a 404. */
export class RubricNotFoundError extends Error {
  constructor(
    public readonly selector: string,
    public readonly available: string[],
  ) {
    super(
      `Rubric not found: ${selector}. Available: ${available.join(', ') || '(none)'}`,
    );
    this.name = 'RubricNotFoundError';
  }
}

export interface RubricRegistry {
  /** Resolves `id` (latest version) or `id@version`. Throws
   * {@link RubricNotFoundError} when unresolved. */
  get(selector: string): Rubric;
  has(selector: string): boolean;
  /** All available selectors as `id@version`, sorted. */
  list(): string[];
}

/**
 * Loads and validates every rubric YAML in `dir` at boot, indexes them by
 * `id@version`, and resolves a bare `id` to its most recent version. Invalid
 * YAML or an invalid rubric throws immediately (fail-fast).
 */
export function loadRubrics(dir: string = DEFAULT_RUBRICS_DIR): RubricRegistry {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort();

  const byKey = new Map<string, Rubric>();
  const latestVersion = new Map<string, number>();

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const text = fs.readFileSync(fullPath, 'utf8');

    let raw: unknown;
    try {
      raw = yaml.load(text);
    } catch (error) {
      throw new Error(`Invalid YAML in ${file}: ${(error as Error).message}`);
    }

    const rubric = parseRubric(raw, file);
    const key = `${rubric.id}@${rubric.version}`;
    if (byKey.has(key)) {
      throw new Error(`Duplicate rubric ${key} (in ${file})`);
    }
    byKey.set(key, rubric);

    const currentLatest = latestVersion.get(rubric.id) ?? 0;
    if (rubric.version > currentLatest) {
      latestVersion.set(rubric.id, rubric.version);
    }
  }

  function resolveKey(selector: string): string | undefined {
    if (selector.includes('@')) {
      return byKey.has(selector) ? selector : undefined;
    }
    const version = latestVersion.get(selector);
    return version === undefined ? undefined : `${selector}@${version}`;
  }

  function list(): string[] {
    return [...byKey.keys()].sort();
  }

  return {
    list,
    has: (selector) => resolveKey(selector) !== undefined,
    get(selector) {
      const key = resolveKey(selector);
      if (key === undefined) {
        throw new RubricNotFoundError(selector, list());
      }
      // Non-null: resolveKey only returns keys present in byKey.
      return byKey.get(key)!;
    },
  };
}
