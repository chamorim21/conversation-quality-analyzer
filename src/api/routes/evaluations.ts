import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { adaptCanonicalConversation } from '../../adapters/canonical.js';
import type { EvaluationMetadata } from '../../domain/evaluation.js';
import { LlmError, LlmRequestError, LlmSchemaError } from '../../evaluation/llm-client.js';
import { evaluateConversation } from '../../evaluation/orchestrator.js';
import { estimateCost } from '../../observability/cost.js';
import type { EvaluationRecord } from '../../persistence/repository.js';
import { assertEvaluable } from '../../preprocessing/evaluability.js';
import { maskConversation } from '../../preprocessing/pii.js';
import { normalizeConversation } from '../../preprocessing/normalize.js';
import { truncateConversation } from '../../preprocessing/truncate.js';
import { PROMPT_VERSION, renderPrompt } from '../../rubric/prompt.js';
import type { ServerDeps } from '../server.js';

/** Selector used when the request does not pin a rubric: the latest version of
 * the `default` rubric (R4). */
const DEFAULT_RUBRIC_SELECTOR = 'default';

/**
 * Request contract (R1). The conversation is validated by the canonical adapter
 * (so it enters through the same door as any other format), which is why it is
 * accepted as `unknown` here.
 */
const EvaluateRequestSchema = z.object({
  conversation: z.unknown(),
  options: z
    .object({
      rubric: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
    })
    .optional(),
});

/**
 * `POST /evaluations` — runs the full pipeline for one conversation: canonical
 * adapter → normalization → PII masking → evaluability check → truncation →
 * single-call LLM evaluation → deterministic aggregation, returns the structured
 * result (R7) and persists a complete audit row (R8). Auditing is on the
 * critical path: a successful evaluation is never returned without its row, and
 * an LLM failure is also recorded before the 502 is surfaced. A DB write failure
 * propagates as a 500. Client/domain errors (400/404/422) short-circuit before
 * the LLM stage and produce no audit row.
 */
export function registerEvaluationsRoute(
  app: FastifyInstance,
  deps: ServerDeps,
  rootLogger: Logger,
): void {
  app.post('/evaluations', async (request, reply) => {
    const startedAt = Date.now();
    const evaluationId = randomUUID();
    const createdAt = new Date().toISOString();
    // One correlation-scoped logger threads the same id through every stage of
    // this evaluation's logs (request → LLM → persistence), R10.
    const log = rootLogger.child({ correlationId: request.correlationId, evaluationId });

    const parsed = EvaluateRequestSchema.parse(request.body);
    const conversation = adaptCanonicalConversation(parsed.conversation);
    const rubric = deps.rubrics.get(parsed.options?.rubric ?? DEFAULT_RUBRIC_SELECTOR);
    const model = parsed.options?.model ?? deps.config.DEFAULT_MODEL;
    log.info(
      { stage: 'request', rubric: `${rubric.id}@${rubric.version}`, model },
      'evaluation received',
    );

    const masked = maskConversation(normalizeConversation(conversation));
    assertEvaluable(masked);
    const prepared = truncateConversation(masked, {
      maxTokens: deps.config.MAX_CONVERSATION_TOKENS,
    });

    // Audit fields known before the LLM call — persisted on both paths. Both the
    // original and masked conversations are kept (R3/R8).
    const auditBase = {
      id: evaluationId,
      ...(conversation.sessionId !== undefined ? { sessionId: conversation.sessionId } : {}),
      createdAt,
      rubricId: rubric.id,
      rubricVersion: rubric.version,
      promptVersion: PROMPT_VERSION,
      model,
      truncated: prepared.truncated,
      correlationId: request.correlationId,
      originalConversation: conversation,
      maskedConversation: masked,
    } satisfies Partial<EvaluationRecord>;

    try {
      const output = await evaluateConversation({
        client: deps.llmClient,
        rubric,
        conversation: prepared,
        model,
      });

      const costUsd = estimateCost(model, output.tokensIn, output.tokensOut);
      const latencyMs = Date.now() - startedAt;
      log.info(
        {
          stage: 'llm',
          model,
          tokensIn: output.tokensIn,
          tokensOut: output.tokensOut,
          retries: output.retries,
          latencyMs,
        },
        'llm evaluation completed',
      );

      const record: EvaluationRecord = {
        ...auditBase,
        status: 'success',
        tokensIn: output.tokensIn,
        tokensOut: output.tokensOut,
        costUsd,
        latencyMs,
        retries: output.retries,
        errorMessage: null,
        renderedPrompt: output.renderedPrompt,
        rawLlmResponse: output.rawResponse,
        result: output.result,
      };
      deps.repository.save(record); // DB write failure → propagates → 500
      log.info({ stage: 'persistence', status: 'success' }, 'evaluation persisted');

      const metadata: EvaluationMetadata = {
        evaluationId,
        rubricId: rubric.id,
        rubricVersion: rubric.version,
        promptVersion: output.promptVersion,
        model,
        tokensIn: output.tokensIn,
        tokensOut: output.tokensOut,
        costUsd,
        latencyMs,
        truncated: prepared.truncated,
        ...(prepared.omittedMessageCount > 0
          ? { omittedMessageCount: prepared.omittedMessageCount }
          : {}),
        createdAt,
      };

      reply.status(200).send({
        evaluationId,
        dimensions: output.result.dimensions,
        overallScore: output.result.overallScore,
        flags: output.result.flags,
        summary: output.result.summary,
        metadata,
      });
    } catch (error) {
      // Record LLM failures too (R8), then let the error handler map to 502.
      if (error instanceof LlmError) {
        log.warn({ stage: 'llm', error: error.message }, 'llm evaluation failed');
        const rendered = renderPrompt(rubric, prepared);
        // Token usage is unknown on a failed call, but the retry count is
        // recoverable when the retries were exhausted (R8 audit fidelity).
        const retries = error instanceof LlmRequestError ? error.attempts - 1 : 0;
        const record: EvaluationRecord = {
          ...auditBase,
          status: 'error',
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          latencyMs: Date.now() - startedAt,
          retries,
          errorMessage: error.message,
          renderedPrompt: { system: rendered.system, user: rendered.user },
          rawLlmResponse: error instanceof LlmSchemaError ? error.lastRaw : null,
          result: null,
        };
        deps.repository.save(record); // DB write failure → propagates → 500
        log.info({ stage: 'persistence', status: 'error' }, 'failure audited');
      }
      throw error;
    }
  });
}
