import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { pino, type Logger } from 'pino';
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
  type EvaluationMetricsData,
} from '../../src/persistence/repository.js';
import { computeMetrics, percentile } from '../../src/observability/metrics.js';
import { buildServer } from '../../src/api/server.js';

const config: AppConfig = {
  OPENAI_API_KEY: 'test-key-not-used',
  DEFAULT_MODEL: 'gpt-4o-mini',
  MAX_CONVERSATION_TOKENS: 30_000,
  LLM_MAX_CONCURRENCY: 5,
  PORT: 3000,
  DB_PATH: './data/test.db',
  LOG_LEVEL: 'silent',
};

const rubrics = loadRubrics();

function validRawFor(request: StructuredRequest<unknown>): unknown {
  const schema = request.schema as {
    properties: { dimensions: { required: string[] }; flags: { required: string[] } };
  };
  const dimensions: Record<string, unknown> = {};
  for (const id of schema.properties.dimensions.required) {
    dimensions[id] = {
      insufficient_data: false,
      score: 4,
      justification: 'ok',
      evidence: [],
    };
  }
  const flags: Record<string, unknown> = {};
  for (const id of schema.properties.flags.required) {
    flags[id] = { triggered: false, justification: '', evidence: [] };
  }
  return { dimensions, flags, summary: 'resumo' };
}

const validConversation = {
  sessionId: 'S_1',
  messages: [
    { role: 'customer', content: 'olá, quero informações' },
    { role: 'attendant', content: 'claro, posso ajudar' },
  ],
};

let app: FastifyInstance | undefined;
let dir: string;
let db: Database;
let logLines: Array<Record<string, unknown>>;
let capturingLogger: Logger;

function makeCapturingLogger(): Logger {
  logLines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) logLines.push(JSON.parse(line));
      }
      cb();
    },
  });
  return pino({ level: 'info' }, stream);
}

function makeApp(llmClient: MockLlmClient): FastifyInstance {
  const repository = createEvaluationRepository(db);
  app = buildServer({ config, rubrics, llmClient, repository, logger: capturingLogger });
  return app;
}

function okMock(): MockLlmClient {
  return new MockLlmClient((req) => ({ raw: validRawFor(req), tokensIn: 100, tokensOut: 20 }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cqa-metrics-'));
  db = openDatabase(join(dir, 'test.db'));
  capturingLogger = makeCapturingLogger();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('percentile', () => {
  it('computes nearest-rank percentiles over 1..100', () => {
    const values = Array.from({ length: 100 }, (_v, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
  });

  it('handles small and unsorted inputs and an empty set', () => {
    expect(percentile([30, 10, 20], 50)).toBe(20);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('computeMetrics', () => {
  it('derives totals, error rate, percentiles, distributions and flags', () => {
    const data: EvaluationMetricsData = {
      total: 4,
      errors: 1,
      totalCostUsd: 0.003,
      totalTokensIn: 300,
      totalTokensOut: 60,
      latenciesMs: [100, 200, 300, 400],
      successResults: [
        {
          rubricId: 'default',
          rubricVersion: 1,
          result: {
            dimensions: [
              { dimensionId: 'communication', score: 4, justification: '', evidence: [] },
              { dimensionId: 'resolution', score: null, justification: '', evidence: [] },
            ],
            flags: [{ flagId: 'hallucination', triggered: true, justification: '', evidence: [] }],
            overallScore: 4,
            summary: '',
          },
        },
        {
          rubricId: 'default',
          rubricVersion: 1,
          result: {
            dimensions: [
              { dimensionId: 'communication', score: 2, justification: '', evidence: [] },
              { dimensionId: 'resolution', score: 5, justification: '', evidence: [] },
            ],
            flags: [{ flagId: 'hallucination', triggered: false, justification: '', evidence: [] }],
            overallScore: 3.5,
            summary: '',
          },
        },
      ],
    };

    const metrics = computeMetrics(data);

    expect(metrics.totalEvaluations).toBe(4);
    expect(metrics.errorCount).toBe(1);
    expect(metrics.errorRate).toBe(0.25);
    expect(metrics.cost.totalUsd).toBe(0.003);
    expect(metrics.cost.averageUsd).toBeCloseTo(0.00075);
    expect(metrics.tokens).toEqual({ totalIn: 300, totalOut: 60 });
    // nearest-rank over [100,200,300,400]
    expect(metrics.latencyMs.p50).toBe(200);
    expect(metrics.latencyMs.p95).toBe(400);
    expect(metrics.flags).toEqual({ hallucination: 1 });

    const comm = metrics.scoresByRubric['default@1'].communication;
    expect(comm).toEqual({
      scored: 2,
      insufficient: 0,
      average: 3, // (4 + 2) / 2
      distribution: { '4': 1, '2': 1 },
    });
    const res = metrics.scoresByRubric['default@1'].resolution;
    expect(res.scored).toBe(1);
    expect(res.insufficient).toBe(1);
    expect(res.average).toBe(5);
  });

  it('partitions score distributions by rubric id and version', () => {
    const dimension = (dimensionId: string, score: number | null) => ({
      dimensionId,
      score,
      justification: '',
      evidence: [],
    });
    const data: EvaluationMetricsData = {
      total: 3,
      errors: 0,
      totalCostUsd: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      latenciesMs: [10, 20, 30],
      successResults: [
        {
          rubricId: 'default',
          rubricVersion: 1,
          result: { dimensions: [dimension('communication', 5)], flags: [], overallScore: 5, summary: '' },
        },
        {
          rubricId: 'default',
          rubricVersion: 2,
          result: { dimensions: [dimension('communication', 1)], flags: [], overallScore: 1, summary: '' },
        },
        {
          rubricId: 'strict',
          rubricVersion: 1,
          result: { dimensions: [dimension('communication', 3)], flags: [], overallScore: 3, summary: '' },
        },
      ],
    };

    const metrics = computeMetrics(data);

    expect(Object.keys(metrics.scoresByRubric).sort()).toEqual([
      'default@1',
      'default@2',
      'strict@1',
    ]);
    expect(metrics.scoresByRubric['default@1'].communication.average).toBe(5);
    expect(metrics.scoresByRubric['default@2'].communication.average).toBe(1);
    expect(metrics.scoresByRubric['strict@1'].communication.average).toBe(3);
    // Versions of the same rubric id are kept separate, not merged.
    expect(metrics.scoresByRubric['default@1'].communication.distribution).toEqual({ '5': 1 });
    expect(metrics.scoresByRubric['default@2'].communication.distribution).toEqual({ '1': 1 });
  });

  it('returns zeros for an empty database', () => {
    const metrics = computeMetrics({
      total: 0,
      errors: 0,
      totalCostUsd: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      latenciesMs: [],
      successResults: [],
    });
    expect(metrics.totalEvaluations).toBe(0);
    expect(metrics.errorRate).toBe(0);
    expect(metrics.cost.averageUsd).toBe(0);
    expect(metrics.latencyMs).toEqual({ p50: 0, p95: 0 });
    expect(metrics.scoresByRubric).toEqual({});
  });
});

describe('GET /metrics', () => {
  it('reflects the evaluations made, including a failed one', async () => {
    const application = makeApp(okMock());
    // Three successful evaluations.
    for (let i = 0; i < 3; i += 1) {
      const res = await application.inject({
        method: 'POST',
        url: '/evaluations',
        payload: { conversation: validConversation },
      });
      expect(res.statusCode).toBe(200);
    }
    // One failing evaluation (502), audited as an error.
    await app!.close();
    const failing = new MockLlmClient(() => {
      throw new LlmRequestError(3, new Error('down'));
    });
    const withFailure = makeApp(failing);
    const failRes = await withFailure.inject({
      method: 'POST',
      url: '/evaluations',
      payload: { conversation: validConversation },
    });
    expect(failRes.statusCode).toBe(502);

    const metricsRes = await withFailure.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.statusCode).toBe(200);
    const body = metricsRes.json();

    expect(body.totalEvaluations).toBe(4);
    expect(body.errorCount).toBe(1);
    expect(body.errorRate).toBe(0.25);
    expect(body.tokens).toEqual({ totalIn: 300, totalOut: 60 });
    expect(body.cost.totalUsd).toBeGreaterThan(0);
    expect(body.cost.averageUsd).toBeCloseTo(body.cost.totalUsd / 4);
    expect(body.latencyMs.p50).toBeGreaterThanOrEqual(0);
    // Only successful evaluations contribute scores; the rubric is default@1.
    const comm = body.scoresByRubric['default@1'].communication;
    expect(comm.scored).toBe(3);
    expect(comm.average).toBe(4);
    expect(comm.distribution).toEqual({ '4': 3 });
  });
});

describe('GET /health', () => {
  it('reports ok when the database is reachable', async () => {
    const res = await makeApp(okMock()).inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('fails with 503 and logs when the database is unreachable', async () => {
    const application = makeApp(okMock());
    db.close(); // simulate the SQLite connection becoming unavailable
    const res = await application.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('error');
    // The failure leaves a diagnostic log line, not just a bare 503.
    expect(logLines.some((l) => String(l.msg).includes('health check failed'))).toBe(true);
  });
});

describe('correlation id across layers', () => {
  it('threads the same correlation id through request, llm and persistence logs', async () => {
    const res = await makeApp(okMock()).inject({
      method: 'POST',
      url: '/evaluations',
      headers: { 'x-correlation-id': 'corr-xyz' },
      payload: { conversation: validConversation },
    });
    expect(res.statusCode).toBe(200);

    const forRequest = logLines.filter((l) => l.correlationId === 'corr-xyz');
    const stages = forRequest.map((l) => l.stage);
    expect(stages).toEqual(expect.arrayContaining(['request', 'llm', 'persistence']));
    // Every logged line for this evaluation shares the one correlation id.
    expect(forRequest.every((l) => l.correlationId === 'corr-xyz')).toBe(true);
  });
});
