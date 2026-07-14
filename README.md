# Conversation Quality Analyzer

A Node.js/TypeScript API that evaluates the quality of customer-support
conversations using an LLM as a judge (LLM-as-judge). It receives a
conversation, applies deterministic preprocessing (normalization, PII masking,
evaluability validation, and token-based truncation), evaluates it with a single
OpenAI call using structured output derived from a **versioned YAML rubric**,
aggregates the scores deterministically, and persists a full audit trail in
SQLite.

The rubric is the single source of truth: the prompt, the structured-output JSON
Schema, and the weighted aggregation are all derived from it at runtime, so
changing the evaluation criteria is a YAML edit — no code change.

## What it does

- **Scores** each conversation on the rubric's dimensions (0–5 with descriptive
  anchors), each with a justification and literal evidence quotes (by message
  index), or `insufficient_data` when there isn't enough to judge.
- **Overall score**: deterministic weighted average (dimensions marked
  `insufficient_data` are dropped and the weights renormalized).
- **Critical flags** (e.g. hallucination, sensitive-data exposure) with evidence.
- **Executive summary** in Portuguese.
- **Full audit trail**: original + masked conversation, rubric@version, rendered
  prompt, raw LLM response, result, tokens/cost/latency, status — persisted for
  every evaluation (success and failure).
- **Observability**: `/metrics` (cost, tokens, latency p50/p95, score
  distributions, flag counts) and `/health` (process + database liveness).

## Pipeline

```
POST /evaluations
  → adapter (external format → canonical)
  → normalization + PII masking
  → evaluability check (→ 422)
  → truncation (head+tail, original indices preserved)
  → single-call LLM evaluation (structured output from the rubric, retry/backoff)
  → deterministic aggregation
  → audit persistence (SQLite)
  → structured response
```

## Requirements

- Node.js >= 20 (developed and tested on Node 22)
- An OpenAI API key — only for local runs and the demo. **The test suite runs
  without a key** (it uses a mocked LLM client).

## Setup

```bash
npm install
cp .env.example .env   # then fill in OPENAI_API_KEY
```

Environment variables (see `.env.example`):

| Variable                  | Default                  | Description                                  |
| ------------------------- | ------------------------ | -------------------------------------------- |
| `OPENAI_API_KEY`          | — (required)             | OpenAI API key                               |
| `DEFAULT_MODEL`           | `gpt-4o-mini`            | Default evaluation model                     |
| `MAX_CONVERSATION_TOKENS` | `30000`                  | Token limit before truncation                |
| `LLM_MAX_CONCURRENCY`     | `5`                      | Maximum concurrent LLM calls                 |
| `PORT`                    | `3000`                   | HTTP port                                    |
| `DB_PATH`                 | `./data/evaluations.db`  | Path to the SQLite audit file                |
| `LOG_LEVEL`               | `info`                   | Log level (pino)                             |

Configuration is validated at boot (fail-fast): a missing key or invalid value
stops the process with a clear error.

## Running locally

```bash
npm run dev     # start the API in watch mode (tsx), loads .env automatically
```

The server logs `server listening` once it is up. It boots only when
`OPENAI_API_KEY` is set.

## API

| Method & path        | Description                                            |
| -------------------- | ----------------------------------------------------- |
| `POST /evaluations`  | Evaluate one conversation, return the structured result |
| `GET /health`        | Liveness (process + SQLite reachability)              |
| `GET /metrics`       | Aggregated metrics over all persisted evaluations     |

### Example request

`POST /evaluations` — the `conversation` is the canonical contract; `options` is
optional. The request below is the `S_84b564f9` sample session **abridged to its
opening two messages**; the response that follows is that session's real output,
so its metadata reflects the full 24-message conversation.

```bash
curl -s http://localhost:3000/evaluations \
  -H 'content-type: application/json' \
  -d '{
    "conversation": {
      "sessionId": "S_84b564f9",
      "channel": "whatsapp",
      "messages": [
        { "role": "customer",  "content": "Eu sou Pessoa_015" },
        { "role": "attendant", "content": "Olá, Karina! Ótimo saber que você atua em Saúde Corporativa. Qual seu principal objetivo ao buscar uma especialização agora?" }
      ]
    },
    "options": { "rubric": "default@1", "model": "gpt-4o-mini" }
  }'
```

### Example response (real output for `S_84b564f9`, justifications abridged)

```json
{
  "evaluationId": "fc2a0235-95f4-4214-a262-b1ca2cf74f15",
  "dimensions": [
    {
      "dimensionId": "communication",
      "score": 4,
      "justification": "Comunicação clara e objetiva, com tom amigável.",
      "evidence": [
        { "messageIndex": 1, "quote": "Olá, Karina! Ótimo saber que você atua em Saúde Corporativa." }
      ]
    },
    { "dimensionId": "contextual_understanding", "score": 4, "justification": "…", "evidence": [] },
    { "dimensionId": "compliance_accuracy",      "score": 4, "justification": "…", "evidence": [] },
    { "dimensionId": "resolution",               "score": 4, "justification": "…", "evidence": [] }
  ],
  "overallScore": 4,
  "flags": [
    { "flagId": "hallucination", "triggered": false, "justification": "", "evidence": [] }
  ],
  "summary": "Atendimento claro, com boa compreensão do contexto e encaminhamento adequado.",
  "metadata": {
    "evaluationId": "fc2a0235-95f4-4214-a262-b1ca2cf74f15",
    "rubricId": "default",
    "rubricVersion": 1,
    "promptVersion": "v1",
    "model": "gpt-4o-mini",
    "tokensIn": 3668,
    "tokensOut": 669,
    "costUsd": 0.0009516,
    "latencyMs": 11305,
    "truncated": false,
    "createdAt": "2026-07-14T03:24:19.679Z"
  }
}
```

### Error responses

| Status | When                                                              |
| ------ | ---------------------------------------------------------------- |
| `400`  | Malformed request / conversation fails the canonical schema      |
| `404`  | Unknown rubric selector (the body lists the available rubrics)   |
| `422`  | Conversation not evaluable (missing a customer/attendant message) |
| `502`  | LLM failed after exhausting retries (the failure is still audited) |
| `500`  | Internal error (e.g. the audit write failed — no 200 without audit) |

### Selecting the rubric and model

- `options.rubric` — e.g. `"default"` (latest version) or `"default@1"` (pinned).
  Unknown selectors return `404` with the list of available rubrics.
- `options.model` — e.g. `"gpt-4o-mini"` (default) or `"gpt-4o"`. Falls back to
  `DEFAULT_MODEL`.

## Rubrics

Rubrics live in `rubrics/*.yaml`, validated at boot (ids unique, weights sum to
1.0, anchors 0–5 complete). Each defines `id`, `version`, `dimensions[]`
(id, name, description, weight, anchors) and `flags[]`. To change the criteria,
edit the YAML and bump the version — the prompt, schema, and aggregation follow
automatically. Old evaluations remain interpretable because each audit row
carries the `rubric@version` and prompt version that produced it.

## Demo

Evaluates conversations from `data/examples.json` against a **running** API
(real OpenAI). Start the server in one terminal, then run the demo in another:

```bash
npm run dev                                   # terminal 1

npm run demo -- --session S_84b564f9          # terminal 2: one session
npm run demo                                  # all conversations
npm run demo -- --session S_84b564f9 --session S_5ee36f40
npm run demo -- --rubric default@1 --model gpt-4o
```

For each conversation it prints the per-dimension scores, overall score,
triggered flags, cost, latency and token usage, plus a run summary.

Suggested sanity cases from the sample dataset:

- `S_84b564f9` — possible hallucination ("most popular course")
- `S_5ee36f40` — loop / loss of context
- `S_213f6505` — CPF collection (PII)
- `S_68c0d237` — honesty about a professor not found

## Docker

The image is multi-stage: the build stage compiles TypeScript and the native
`better-sqlite3` addon; the slim runtime stage reuses the compiled modules.

```bash
docker build -t conversation-quality-analyzer .

docker run --rm -p 3000:3000 \
  -e OPENAI_API_KEY=sk-your-key \
  conversation-quality-analyzer
```

To persist the audit database across runs, mount a volume at `/app/data`:

```bash
docker run --rm -p 3000:3000 \
  -e OPENAI_API_KEY=sk-your-key \
  -v "$(pwd)/data:/app/data" \
  conversation-quality-analyzer
```

## Testing

```bash
npm test        # run the full suite (vitest) — no API key required
```

The suite covers preprocessing, the rubric subsystem, adapters, the LLM
layer/orchestrator/aggregation, and the API end to end (using a mocked LLM
client), including audit persistence and metrics.

## Scripts

```bash
npm run dev     # start the API in watch mode (tsx), loads .env
npm run build   # compile TypeScript to dist/
npm start       # run the compiled build
npm test        # run the test suite (no API key needed)
npm run demo    # evaluate sample conversations against a running API
```

## Project structure

```
src/
  api/            Fastify server, routes (evaluations, health, metrics), error mapping
  adapters/       external format → canonical conversation
  preprocessing/  normalization, PII masking, evaluability, truncation
  rubric/         YAML schema/loader, prompt + JSON Schema generation
  evaluation/     LLM client (retry/backoff), single-call orchestrator, aggregation
  persistence/    SQLite (WAL) + migrations, audit repository
  observability/  logger, cost, metrics
  config/         env validation, pricing table
rubrics/          versioned YAML rubrics
data/             sample conversations (demo/tests fixture)
scripts/          demo script
```

## Notes and limitations

- **No authentication** and **synchronous** evaluation by design (prototype). The
  scale-out path (queue + workers + Postgres, auth, rate limiting) is documented
  in the solution document.
- PII masking is regex-based (best-effort); NER is a documented improvement.
- The original (unmasked) conversation is stored only in the local SQLite audit
  trail; only the masked conversation is sent to OpenAI.
- A second, more sophisticated architecture (multi-agent, multi-call) is analyzed
  in the solution document but deliberately not implemented (time-box).
