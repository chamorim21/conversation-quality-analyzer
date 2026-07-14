import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adaptCanonicalConversation } from '../../adapters/canonical.js';
import { getPricing } from '../../config/pricing.js';
import type { EvaluationMetadata } from '../../domain/evaluation.js';
import { evaluateConversation } from '../../evaluation/orchestrator.js';
import { assertEvaluable } from '../../preprocessing/evaluability.js';
import { maskConversation } from '../../preprocessing/pii.js';
import { normalizeConversation } from '../../preprocessing/normalize.js';
import { truncateConversation } from '../../preprocessing/truncate.js';
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

/** Estimated USD cost from token usage and the pricing table. Returns 0 for a
 * model with no known price rather than guessing. */
function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = getPricing(model);
  if (!pricing) return 0;
  return tokensIn * pricing.inputPerToken + tokensOut * pricing.outputPerToken;
}

/**
 * `POST /evaluations` — runs the full pipeline for one conversation: canonical
 * adapter → normalization → PII masking → evaluability check → single-call LLM
 * evaluation → deterministic aggregation, and returns the structured result
 * (R7). Persistence and truncation surfacing arrive in later tasks; domain
 * errors are turned into 400/404/422/502 by the server's error handler.
 */
export function registerEvaluationsRoute(app: FastifyInstance, deps: ServerDeps): void {
  app.post('/evaluations', async (request, reply) => {
    const startedAt = Date.now();

    const parsed = EvaluateRequestSchema.parse(request.body);
    const conversation = adaptCanonicalConversation(parsed.conversation);
    const rubric = deps.rubrics.get(parsed.options?.rubric ?? DEFAULT_RUBRIC_SELECTOR);
    const model = parsed.options?.model ?? deps.config.DEFAULT_MODEL;

    const masked = maskConversation(normalizeConversation(conversation));
    assertEvaluable(masked);
    const prepared = truncateConversation(masked, {
      maxTokens: deps.config.MAX_CONVERSATION_TOKENS,
    });

    const output = await evaluateConversation({
      client: deps.llmClient,
      rubric,
      conversation: prepared,
      model,
    });

    const metadata: EvaluationMetadata = {
      evaluationId: randomUUID(),
      rubricId: rubric.id,
      rubricVersion: rubric.version,
      promptVersion: output.promptVersion,
      model,
      tokensIn: output.tokensIn,
      tokensOut: output.tokensOut,
      costUsd: estimateCost(model, output.tokensIn, output.tokensOut),
      latencyMs: Date.now() - startedAt,
      truncated: prepared.truncated,
      ...(prepared.omittedMessageCount > 0
        ? { omittedMessageCount: prepared.omittedMessageCount }
        : {}),
      createdAt: new Date().toISOString(),
    };

    reply.status(200).send({
      evaluationId: metadata.evaluationId,
      dimensions: output.result.dimensions,
      overallScore: output.result.overallScore,
      flags: output.result.flags,
      summary: output.result.summary,
      metadata,
    });
  });
}
