# AI usage in development

This document records, continuously, where AI (a coding assistant) was used
during development, for what purpose, and how its suggestions were validated. It
is updated at the end of each phase — not reconstructed from memory at the end
of the project.

For each relevant use we record three points:

- **Where**: which part of the work the AI was applied to.
- **Why**: what the goal was.
- **How it was validated**: how we confirmed the suggestion was correct.

---

## Phase 1 — Project foundation

- **Where**: project scaffolding (package.json, tsconfig, vitest), environment
  variable validation (`src/config/env.ts`), the pricing table
  (`src/config/pricing.ts`), the structured logger
  (`src/observability/logger.ts`), and the documentation skeleton.
- **Why**: to set up a minimal, typed, testable base with fail-fast validated
  configuration and no secret leakage in the logs.
- **How it was validated**:
  - Unit tests for `env.ts` (`tests/config/env.test.ts`) covering loading with
    defaults, numeric coercion, missing/empty API key, and invalid values;
    `npm test` passes.
  - `OPENAI_API_KEY` redaction configured in the logger (pino `redact`) to
    guarantee the key never appears in the logs.
  - Manual check of the per-token prices against OpenAI's public table.

## Phase 2 — Domain + rubric (source of truth)

- **Where**: canonical domain schemas (`src/domain/conversation.ts`,
  `src/domain/evaluation.ts`) and the rubric subsystem (`src/rubric/schema.ts`,
  `loader.ts`, `prompt.ts`, `json-schema.ts`), plus `rubrics/default.v1.yaml`.
- **Why**: make the rubric the single source of truth — the evaluation prompt
  and the OpenAI structured-output JSON Schema are both derived from it at
  runtime, so adding or changing a criterion is a YAML edit with no code change.
- **How it was validated**:
  - Unit tests (`tests/rubric/*.test.ts`, 17 tests) covering: loader fail-fast
    (weights not summing to 1, duplicate ids, missing anchor level, invalid
    YAML, duplicate `id@version`), version resolution (`default` → latest), and
    the key acceptance criterion that a new dimension added to a rubric appears
    in both the rendered prompt and the generated JSON Schema.
  - A recursive test asserting the generated schema obeys OpenAI strict mode
    (`additionalProperties: false` and full `required` on every object).
  - Manual end-to-end check loading the real `rubrics/default.v1.yaml`: weights
    sum to 1.0, 4 dimensions and 4 flags flow into the schema and prompt.
