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

## Phase 3 — Deterministic preprocessing

- **Where**: text normalization, PII masking, evaluability check and token-based
  truncation (`src/preprocessing/{normalize,pii,evaluability,truncate}.ts`).
- **Why**: run every deterministic, cheap step before any LLM call — mask
  sensitive data, reject unevaluable conversations (R2), and cap conversation
  size while preserving the opening and closing and the original message indices.
- **How it was validated**: unit tests (`tests/preprocessing/*.test.ts`) covering
  PII formats (valid, boundary, and non-PII that must not be masked), the
  evaluability rules, mojibake tolerance, and truncation (head+tail kept, marker
  inserted, original indices preserved, `truncated` flag).

## Phase 4 — Input adapters

- **Where**: canonical passthrough and the example-format converter
  (`src/adapters/{canonical,example-json}.ts`) plus the `data/examples.json`
  fixture.
- **Why**: let any external format enter through an adapter into one canonical
  contract, so the core never changes when a new format is added.
- **How it was validated**: unit tests covering role mapping
  (`human`→`customer`, `ai`→`attendant`), content preserved (including embedded
  `"Reposta da mensagem:"` prefixes), malformed messages raising a clear error,
  and the 20-conversation fixture loading.

## Phase 5 — LLM layer, orchestrator and aggregation

- **Where**: the `LlmClient` interface with the OpenAI implementation and a mock
  (`src/evaluation/llm-client.ts`), the single-call orchestrator
  (`orchestrator.ts`) and deterministic aggregation (`aggregate.ts`).
- **Why**: a thin, swappable client (retry/backoff, single re-prompt on an
  invalid response, concurrency semaphore) behind which the orchestrator turns a
  rubric into a prompt/schema, one structured call, and a weighted score.
- **How it was validated**: unit tests with fake timing and a mock client
  (retry/backoff, exhaustion → explicit error, re-prompt, semaphore limit,
  aggregation with `insufficient_data` renormalization). The OpenAI wiring is
  tested with an injected fake OpenAI, and a contract test keeps the JSON Schema
  and the Zod validator in lockstep. No test needs an API key.

## Phase 6 — Minimal end-to-end API (v0.1-mvp)

- **Where**: the Fastify server, `POST /evaluations`, `GET /health`, the
  domain-error → HTTP mapping and correlation id (`src/api/*`), plus wiring
  truncation through the prompt/orchestrator so cited evidence keeps its original
  message indices.
- **Why**: expose the full pipeline (adapter → normalize → mask → evaluability →
  truncate → single-call evaluation → aggregation) as one synchronous endpoint
  returning the structured R7 body.
- **How it was validated**:
  - Integration tests with the mock client (no API key): 200 with the full R7
    body, 400 (invalid schema and malformed JSON), 404 (unknown rubric listing
    the available ones), 422 (not evaluable, with reason), 502 (retries
    exhausted), a test asserting only PII-masked content reaches the LLM, and a
    truncation test.
  - **Real-OpenAI manual validation** on session `S_84b564f9` with `gpt-4o-mini`:
    HTTP 200, coherent structured analysis (all four dimensions scored 4, overall
    4, no flags), with literal evidence and message indices; `tokensIn≈3668`,
    `tokensOut≈669`, cost ≈ US$0.00095, latency ≈ 11s.
  - Calibration observation from that run: the attendant's unsupported "mais
    procurado atualmente" claim was cited but the `hallucination` flag was left
    off. Noted as a known limitation of `gpt-4o-mini` on subtle cases — motivates
    offering `gpt-4o` and building a golden dataset (both already in the plan).

## Phase 7 — Persistence and audit trail

- **Where**: SQLite (WAL) with idempotent boot migrations, the audit repository
  (`src/persistence/*`), cost calculation (`src/observability/cost.ts`), and
  wiring the audit write into the request path.
- **Why**: persist a complete, reproducible audit row (R8) for every evaluation —
  success and failure — on the critical path, so no 200 is ever returned without
  its audit.
- **How it was validated**: repository round-trip tests over a temp SQLite,
  idempotent-migration test, and API tests proving a full success audit row, a
  failure audit on a 502, and a 500 when the write fails.

## Phase 8 — Metrics and observability

- **Where**: `GET /metrics` (pure `computeMetrics` + repository aggregates), the
  SQLite reachability check in `GET /health`, and correlation-id logging across
  the request/LLM/persistence stages.
- **Why**: expose operational metrics (cost, tokens, latency p50/p95, score
  distributions, flags) and make failures observable end to end.
- **How it was validated**: unit tests for the percentile and `computeMetrics`
  math against known values (including multi-rubric-version grouping), an
  integration test with a failed evaluation in the mix, `/health` up/down, and a
  correlation-id-across-layers log assertion.

## Phase 9 — Demo, Docker and README (v1.0)

- **Where**: `scripts/demo.ts` (evaluates sample conversations against the live
  API), the multi-stage `Dockerfile` (native `better-sqlite3` compiled in the
  build stage, reused in the slim runtime), and the complete `README.md`.
- **Why**: package the prototype for real use and provide the real-time
  demonstration of the implemented single-call approach.
- **How it was validated**:
  - `docker build` succeeded and the container served `/health`, `/metrics`, and
    a 422 with only a dummy key (no OpenAI cost).
  - **Sanity cases run against the real API** (`gpt-4o-mini`, via `npm run demo`),
    total cost ≈ US$0.0033, avg latency ≈ 14 s:
    - `S_5ee36f40` (loop / loss of context): correctly discriminated — overall
      **2.5**, dimensions 2/2/4/2, and the `customer_frustration` flag triggered.
    - `S_84b564f9` (possible hallucination): overall 4, no flags — the subtle
      hallucination was again not flagged (consistent `gpt-4o-mini` limitation).
    - `S_213f6505` (CPF collection): overall 4, no flags. Note: PII is masked
      before the LLM, so `sensitive_data_exposure` is intentionally hard to
      trigger from the masked text — a design nuance, not a judge miss.
    - `S_68c0d237` (honesty about a professor): overall 4, no flags.
  - Takeaway: the judge cleanly separates the genuinely problematic conversation
    (the loop) from the acceptable ones; subtle hallucination detection is the
    main gap and is addressed in the solution document (model choice + golden
    dataset).

## Phase 10 — Deliverables (AI_USAGE + solution document)

- **Where**: consolidating this record and writing the solution document
  (`docs/SOLUTION.md`).
- **Why**: produce the two written deliverables of the challenge (this AI-usage
  log and the solution document) without contradicting the implementation.
- **How it was validated**: the solution document's economic-viability and
  architecture-comparison sections use real numbers read from `GET /metrics` over
  the four sanity evaluations (avg ≈ US$0.00083/evaluation, latency p50 ≈ 11.2 s /
  p95 ≈ 17.2 s); every claim was cross-checked against the code and the test suite.

---

# How AI was used — at a glance

- **Assistant**: an AI coding assistant (Claude Code) was used throughout, driven
  by a spec-first workflow (interview → SPEC → PLAN → per-task implement/review).
- **Scope**: scaffolding, domain/rubric modelling, preprocessing, the LLM
  layer/orchestrator/aggregation, the API, persistence, observability, the demo,
  the Dockerfile, and these documents.
- **Validation discipline** (the "how it was validated" of each phase, summarized):
  - Automated tests were written alongside every module and run **without an API
    key** (a mocked LLM client), so behavior is verified deterministically —
    122 tests at v1.0.
  - The LLM-dependent behavior was checked with **real OpenAI runs** on the
    challenge's own sample conversations (manual MVP validation + the four sanity
    cases), and the numbers were read back from the audit trail and `/metrics`.
  - Every AI suggestion was reviewed against the spec and, where it touched
    behavior, locked with a test before being accepted; nothing was taken on trust.
