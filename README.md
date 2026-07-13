# Conversation Quality Analyzer

A Node.js/TypeScript API that evaluates the quality of customer-support
conversations using an LLM as a judge (LLM-as-judge). It receives a
conversation, applies deterministic preprocessing (normalization, PII masking,
evaluability validation, and token-based truncation), evaluates it with a single
OpenAI call using structured output derived from a versioned YAML rubric,
aggregates the scores deterministically, and persists a full audit trail in
SQLite.

> **Status:** work in progress. This README is a skeleton and will be completed
> as the implementation proceeds (setup, local and Docker execution, sample
> request/response, rubric/model selection).

## Requirements

- Node.js >= 20
- An OpenAI API key (only for manual validation and the demo; the test suite
  runs without a key, using a mocked LLM client)

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

## Scripts

```bash
npm run dev     # start the API in watch mode (tsx)
npm run build   # compile TypeScript to dist/
npm start       # run the compiled build
npm test        # run the test suite (vitest, no API key needed)
```

## Structure

See `.claude/work/conversation-quality-analyzer/` for the spec, plan, and tasks.
The layered architecture is described in the implementation plan.
