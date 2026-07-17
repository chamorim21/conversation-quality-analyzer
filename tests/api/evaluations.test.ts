import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { pino } from 'pino';
import type { AppConfig } from '../../src/config/env.js';
import { loadRubrics } from '../../src/rubric/loader.js';
import {
  LlmRequestError,
  MockLlmClient,
  type StructuredRequest,
} from '../../src/evaluation/llm-client.js';
import { openDatabase } from '../../src/persistence/db.js';
import {
  createEvaluationRepository,
  type EvaluationRepository,
} from '../../src/persistence/repository.js';
import { buildServer } from '../../src/api/server.js';

const config: AppConfig = {
  OPENAI_API_KEY: 'test-key-not-used',
  DEFAULT_MODEL: 'gpt-5.4-mini',
  MAX_CONVERSATION_TOKENS: 30_000,
  LLM_MAX_CONCURRENCY: 5,
  PORT: 3000,
  DB_PATH: './data/test.db',
  LOG_LEVEL: 'silent',
};

const rubrics = loadRubrics();

/**
 * Builds a valid raw response for whatever rubric the orchestrator asks about,
 * by reading the required dimension/flag ids straight from the generated JSON
 * Schema. Keeps the test independent of the specific rubric contents.
 */
function validRawFor(request: StructuredRequest<unknown>): unknown {
  const schema = request.schema as {
    properties: {
      dimensions: { required: string[] };
      flags: { required: string[] };
    };
  };
  const dimensions: Record<string, unknown> = {};
  for (const id of schema.properties.dimensions.required) {
    dimensions[id] = {
      insufficient_data: false,
      score: 4,
      justification: 'justificativa',
      evidence: [{ message_index: 1, quote: 'olá' }],
    };
  }
  const flags: Record<string, unknown> = {};
  for (const id of schema.properties.flags.required) {
    flags[id] = { triggered: false, justification: 'sem sinais', evidence: [] };
  }
  return { dimensions, flags, summary: 'Atendimento adequado.' };
}

const validConversation = {
  sessionId: 'S_1',
  channel: 'whatsapp',
  messages: [
    { role: 'customer', content: 'Olá, quero informações sobre o curso' },
    { role: 'attendant', content: 'Claro! Posso te ajudar com isso.' },
  ],
};

let app: FastifyInstance | undefined;
let dir: string;
let db: Database;
let repo: EvaluationRepository;

function defaultMock(): MockLlmClient {
  return new MockLlmClient((req) => ({
    raw: validRawFor(req),
    tokensIn: 100,
    tokensOut: 20,
  }));
}

const silentLogger = pino({ level: 'silent' });

function makeApp(
  llmClient = defaultMock(),
  cfg: AppConfig = config,
  repository: EvaluationRepository = repo,
): FastifyInstance {
  app = buildServer({ config: cfg, rubrics, llmClient, repository, logger: silentLogger });
  return app;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cqa-api-'));
  db = openDatabase(join(dir, 'test.db'));
  repo = createEvaluationRepository(db);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /evaluations', () => {
  it('returns 200 with the full R7 body for a valid conversation', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/evaluations',
      payload: { conversation: validConversation, options: { rubric: 'default@1' } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.evaluationId).toEqual(expect.any(String));
    expect(body.dimensions).toHaveLength(4);
    expect(body.dimensions[0]).toMatchObject({
      dimensionId: 'communication',
      score: 4,
      justification: 'justificativa',
      evidence: [{ messageIndex: 1, quote: 'olá' }],
    });
    expect(body.overallScore).toBe(4);
    expect(body.flags).toHaveLength(4);
    expect(body.summary).toBe('Atendimento adequado.');
    expect(body.metadata).toMatchObject({
      rubricId: 'default',
      rubricVersion: 1,
      promptVersion: 'v1',
      model: 'gpt-5.4-mini',
      tokensIn: 100,
      tokensOut: 20,
      truncated: false,
    });
    expect(body.metadata.costUsd).toBeGreaterThan(0);
    expect(body.metadata.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.metadata.evaluationId).toBe(body.evaluationId);
  });

  it('persists a complete success audit row (R8)', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/evaluations',
      headers: { 'x-correlation-id': 'corr-abc' },
      payload: { conversation: validConversation, options: { rubric: 'default@1' } },
    });
    expect(response.statusCode).toBe(200);
    const { evaluationId } = response.json();

    const record = repo.findById(evaluationId);
    expect(record).toBeDefined();
    expect(record).toMatchObject({
      id: evaluationId,
      sessionId: 'S_1',
      status: 'success',
      rubricId: 'default',
      rubricVersion: 1,
      promptVersion: 'v1',
      model: 'gpt-5.4-mini',
      tokensIn: 100,
      tokensOut: 20,
      retries: 0,
      truncated: false,
      errorMessage: null,
      correlationId: 'corr-abc',
    });
    expect(record?.costUsd).toBeGreaterThan(0);
    // Full audit payload: original and masked conversations, prompt, raw response, result.
    expect(record?.originalConversation).toEqual(validConversation);
    expect(record?.maskedConversation).toMatchObject({ sessionId: 'S_1' });
    expect(record?.renderedPrompt).toMatchObject({
      system: expect.any(String),
      user: expect.any(String),
    });
    expect(record?.rawLlmResponse).toMatchObject({ summary: 'Atendimento adequado.' });
    expect(record?.result).toMatchObject({ overallScore: 4 });
  });

  it('echoes a correlation id header', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/evaluations',
      headers: { 'x-correlation-id': 'corr-123' },
      payload: { conversation: validConversation },
    });
    expect(response.headers['x-correlation-id']).toBe('corr-123');
  });

  it('returns 400 when the conversation is not schema-valid', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/evaluations',
      payload: { conversation: { messages: [{ role: 'customer' }] } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Invalid request');
  });

  it('returns 400 for a malformed JSON body', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/evaluations',
      headers: { 'content-type': 'application/json' },
      payload: '{ not valid json',
    });
    expect(response.statusCode).toBe(400);
  });

  it('sends only PII-masked content to the LLM', async () => {
    let userPrompt = '';
    const client = new MockLlmClient((req) => {
      userPrompt = req.user;
      return { raw: validRawFor(req), tokensIn: 10, tokensOut: 5 };
    });
    const response = await makeApp(client).inject({
      method: 'POST',
      url: '/evaluations',
      payload: {
        conversation: {
          messages: [
            { role: 'customer', content: 'meu CPF é 123.456.789-01' },
            { role: 'attendant', content: 'obrigado, vou verificar' },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(userPrompt).toContain('[CPF]');
    expect(userPrompt).not.toContain('123.456.789-01');
  });

  it('truncates a conversation over the token budget and reports it in metadata', async () => {
    const tinyBudget: AppConfig = { ...config, MAX_CONVERSATION_TOKENS: 5 };
    let userPrompt = '';
    const client = new MockLlmClient((req) => {
      userPrompt = req.user;
      return { raw: validRawFor(req), tokensIn: 10, tokensOut: 5 };
    });
    const conversation = {
      messages: Array.from({ length: 8 }, (_unused, i) => ({
        role: i % 2 === 0 ? ('customer' as const) : ('attendant' as const),
        content: `mensagem número ${i} com bastante texto para gastar tokens`,
      })),
    };
    const response = await makeApp(client, tinyBudget).inject({
      method: 'POST',
      url: '/evaluations',
      payload: { conversation },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.metadata.truncated).toBe(true);
    expect(body.metadata.omittedMessageCount).toBeGreaterThan(0);
    // Head and tail keep their original indices; the marker sits between them.
    expect(userPrompt).toContain('[0] customer:');
    expect(userPrompt).toContain('[7] attendant:');
    expect(userPrompt).toContain('mensagens omitidas');
  });

  it('returns 404 with the available rubrics for an unknown rubric', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/evaluations',
      payload: { conversation: validConversation, options: { rubric: 'nope@9' } },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().available).toContain('default@1');
  });

  it('returns 422 with a reason when the conversation is not evaluable', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/evaluations',
      payload: {
        conversation: {
          messages: [
            { role: 'customer', content: 'oi' },
            { role: 'customer', content: 'tem alguém?' },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatch(/attendant/i);
  });

  it('returns 502 and audits the failure when the LLM exhausts retries', async () => {
    const failing = new MockLlmClient(() => {
      throw new LlmRequestError(3, new Error('rate limit'));
    });
    const response = await makeApp(failing).inject({
      method: 'POST',
      url: '/evaluations',
      payload: { conversation: validConversation },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('LLM evaluation failed');

    // A failure audit row must exist, with the error and retry count recorded
    // and no result.
    const rows = db
      .prepare('SELECT status, error_message, result, rendered_prompt, retries FROM evaluations')
      .all() as Array<{
      status: string;
      error_message: string | null;
      result: string | null;
      rendered_prompt: string | null;
      retries: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('error');
    expect(rows[0].error_message).toContain('LLM request failed');
    expect(rows[0].result).toBeNull();
    expect(rows[0].rendered_prompt).not.toBeNull();
    expect(rows[0].retries).toBe(2); // 3 attempts → 2 retries
  });

  it('does not write an audit row for a pre-LLM error (422)', async () => {
    const response = await makeApp().inject({
      method: 'POST',
      url: '/evaluations',
      payload: {
        conversation: {
          messages: [
            { role: 'customer', content: 'oi' },
            { role: 'customer', content: 'tem alguém?' },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(422);
    const count = db.prepare('SELECT COUNT(*) AS n FROM evaluations').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('returns 500 and does not answer 200 when the audit write fails', async () => {
    const brokenRepo: EvaluationRepository = {
      save() {
        throw new Error('disk full');
      },
      findById() {
        return undefined;
      },
    };
    const response = await makeApp(defaultMock(), config, brokenRepo).inject({
      method: 'POST',
      url: '/evaluations',
      payload: { conversation: validConversation },
    });
    expect(response.statusCode).toBe(500);
  });
});

describe('GET /health', () => {
  it('reports liveness', async () => {
    const response = await makeApp().inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
