# CLAUDE.md

Guidance for working in this repository. See `README.md` for the user-facing
overview and `docs/SOLUTION.md` for design rationale and scale-out notes.

## What this is

A Node.js/TypeScript API that scores customer-support conversations with an
LLM-as-judge. A conversation goes through deterministic preprocessing, one
OpenAI call driven by a **versioned YAML rubric** (structured output), a
deterministic weighted aggregation, and a full SQLite audit write.

**The rubric is the single source of truth.** The prompt, the structured-output
JSON Schema, and the weighted aggregation are all derived from the YAML at
runtime. Changing the evaluation criteria is a YAML edit + version bump — not a
code change. Preserve this: don't hardcode dimension ids, weights, or anchors in
code paths that could read them from the loaded rubric.

## Commands

```bash
npm install
npm run dev        # API in watch mode (tsx), loads .env; needs OPENAI_API_KEY
npm test           # full vitest suite — NO API key required (LLM client is mocked)
npm run typecheck  # tsc --noEmit over src + scripts
npm run build      # compile to dist/
npm run demo -- --session S_84b564f9   # evaluate a sample vs a RUNNING API (real OpenAI)
```

Run a single test file: `npx vitest run tests/rubric/prompt.test.ts`.

## Conventions

- **Language:** all code, comments, strings, tests, and repo infrastructure
  (README, this file) are in **English**. The two challenge deliverables —
  `docs/AI_USAGE.md` and `docs/SOLUTION.md` — are in **Portuguese** (their
  audience is the challenge reviewer). Executive summaries produced *by the
  judge* are also in Portuguese (product output, not source).
- **Message roles are `customer` and `attendant`** — never `agent`/`user`
  (avoids collision with "AI agent"). Any bot or human support rep is
  `attendant`. See `src/domain/conversation.ts`.
- **TypeScript strict**, ESM (`"type": "module"`, NodeNext). `noUnusedLocals` /
  `noUnusedParameters` are on — dead bindings fail the build.
- **Zod** validates every boundary (request body, rubric YAML, env, LLM
  response). Structural validation lives in the schema; semantic rules (e.g.
  evaluability) are separate checks that return readable errors.
- Keep the mandatory scope **simple and effective**. Sophistication that isn't
  needed to run goes into `docs/SOLUTION.md`, not into the code.

## Architecture (request flow)

`POST /evaluations` →
adapter (external → canonical) →
normalization + PII masking →
evaluability check (→ 422) →
truncation (head+tail, original message indices preserved) →
single LLM call (structured output from rubric, retry/backoff) →
deterministic aggregation →
**audit persistence (no 200 without a successful audit write)** →
structured response.

Source layout (`src/`):

| Dir              | Responsibility |
| ---------------- | -------------- |
| `domain/`        | Canonical `Conversation` / `Evaluation` types (Zod) |
| `adapters/`      | External formats → canonical (`example-json`, `canonical`) |
| `preprocessing/` | `normalize`, `pii`, `evaluability`, `truncate` |
| `rubric/`        | YAML `schema`/`loader`, `prompt` + `json-schema` generation |
| `evaluation/`    | `llm-client` (retry/backoff), `orchestrator` (single call), `aggregate` |
| `persistence/`   | SQLite (WAL) `db` + `migrations`, audit `repository` |
| `observability/` | `logger` (pino), `cost`, `metrics` |
| `config/`        | `env` (fail-fast validation at boot), `pricing` table |
| `api/`           | Fastify `server`, `routes/`, error → HTTP status mapping |

Rubrics live in `rubrics/*.yaml`, validated at boot (unique ids, weights sum to
1.0, complete 0–5 anchors). Each audit row stores `rubric@version` + prompt
version so old evaluations stay interpretable after the rubric changes.

## Invariants — don't break these

- **Audit-before-response:** an evaluation (success *and* failure) is persisted
  before responding. A failed audit write is a 500, never a silent 200.
- **Only the masked conversation is sent to OpenAI.** The original (unmasked)
  text is stored only in the local SQLite audit.
- **Aggregation is deterministic:** weighted average, dimensions marked
  `insufficient_data` dropped and remaining weights renormalized. No LLM math.
- **Evidence uses original message indices** even after truncation.
- Config is validated at boot (fail-fast): missing key / invalid value stops the
  process with a clear error rather than failing mid-request.

## Testing

The suite runs without an API key (mocked `llm-client`) and covers
preprocessing, the rubric subsystem, adapters, orchestrator/aggregation, and the
API end-to-end including audit persistence and the response contract. Add tests
alongside the code they cover under `tests/<area>/`. The **only** thing that
needs a real key is `npm run demo`.
