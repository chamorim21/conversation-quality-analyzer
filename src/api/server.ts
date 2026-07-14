import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppConfig } from '../config/env.js';
import { LlmError, type LlmClient } from '../evaluation/llm-client.js';
import { NotEvaluableError } from '../preprocessing/evaluability.js';
import type { EvaluationRepository } from '../persistence/repository.js';
import { RubricNotFoundError, type RubricRegistry } from '../rubric/loader.js';
import { logger } from '../observability/logger.js';
import { registerEvaluationsRoute } from './routes/evaluations.js';
import { registerHealthRoute } from './routes/health.js';

/** Everything the HTTP layer needs, injected so tests can supply a
 * {@link MockLlmClient}, a test rubric registry, and a temp-DB repository
 * without an API key. */
export interface ServerDeps {
  config: AppConfig;
  rubrics: RubricRegistry;
  llmClient: LlmClient;
  repository: EvaluationRepository;
}

const CORRELATION_ID_HEADER = 'x-correlation-id';

declare module 'fastify' {
  interface FastifyRequest {
    /** Correlation ID for this request, echoed in the response and logs (R10). */
    correlationId: string;
  }
}

/**
 * Builds the Fastify app with the evaluation pipeline wired up. Kept as a
 * factory (no side effects, no network) so it can be exercised with
 * `app.inject` in tests. The domain-error → HTTP-status mapping lives in the
 * single error handler below; routes just throw.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // Correlation ID per request (R10): reuse an incoming id or mint one, and
  // echo it back so a caller can correlate its request with the audit trail.
  app.decorateRequest('correlationId', '');
  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers[CORRELATION_ID_HEADER];
    const incoming = Array.isArray(header) ? header[0] : header;
    request.correlationId = incoming && incoming.length > 0 ? incoming : randomUUID();
    reply.header(CORRELATION_ID_HEADER, request.correlationId);
  });

  app.setErrorHandler((error, request, reply) => {
    const log = logger.child({ correlationId: request.correlationId });

    // Invalid input: Zod validation of the request body (R1) → 400.
    if (error instanceof ZodError) {
      reply.status(400).send({ error: 'Invalid request', issues: error.issues });
      return;
    }
    // Unknown rubric/version (R4) → 404 listing what is available.
    if (error instanceof RubricNotFoundError) {
      reply.status(404).send({ error: error.message, available: error.available });
      return;
    }
    // Deterministic evaluability failure (R2) → 422 with a readable reason.
    if (error instanceof NotEvaluableError) {
      reply.status(422).send({ error: error.reason });
      return;
    }
    // LLM failed after exhausting retries / bad schema (R9) → 502, never silent.
    if (error instanceof LlmError) {
      log.error({ err: error }, 'LLM evaluation failed');
      reply.status(502).send({ error: 'LLM evaluation failed', detail: error.message });
      return;
    }
    // Fastify's own 4xx (e.g. malformed JSON body) carry a statusCode.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      reply.status(statusCode).send({ error: (error as Error).message });
      return;
    }

    log.error({ err: error }, 'Unhandled error');
    reply.status(500).send({ error: 'Internal server error' });
  });

  registerHealthRoute(app);
  registerEvaluationsRoute(app, deps);

  return app;
}
