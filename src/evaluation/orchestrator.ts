import { z } from 'zod';
import type { Conversation } from '../domain/conversation.js';
import type {
  DimensionResult,
  EvaluationResult,
  Evidence,
  FlagResult,
} from '../domain/evaluation.js';
import { buildResponseJsonSchema } from '../rubric/json-schema.js';
import { renderPrompt } from '../rubric/prompt.js';
import type { Rubric } from '../rubric/schema.js';
import { aggregateEvaluation } from './aggregate.js';
import type { LlmClient } from './llm-client.js';

/** Schema name sent to the OpenAI structured-output API. */
const SCHEMA_NAME = 'conversation_evaluation';

// Every object below is `.strict()` to mirror the `additionalProperties: false`
// set on every object in the generated JSON Schema (`rubric/json-schema.ts`), so
// the two definitions of the response contract stay in lockstep.
const EvidenceSchema = z
  .object({
    message_index: z.number().int(),
    quote: z.string(),
  })
  .strict();

const DimensionResponseSchema = z
  .object({
    insufficient_data: z.boolean(),
    score: z.union([z.number().int().min(0).max(5), z.null()]),
    justification: z.string(),
    evidence: z.array(EvidenceSchema),
  })
  .strict();

const FlagResponseSchema = z
  .object({
    triggered: z.boolean(),
    justification: z.string(),
    evidence: z.array(EvidenceSchema),
  })
  .strict();

/**
 * Builds a Zod schema mirroring the rubric-derived JSON Schema, used to
 * re-validate the raw LLM response (R5). Like the prompt and the JSON Schema, it
 * is derived from the rubric, so a new dimension or flag is validated with no
 * code change. `.strict()` rejects unexpected keys.
 */
export function buildResponseValidator(rubric: Rubric) {
  const dimensionShape = Object.fromEntries(
    rubric.dimensions.map((d) => [d.id, DimensionResponseSchema]),
  );
  const flagShape = Object.fromEntries(
    rubric.flags.map((f) => [f.id, FlagResponseSchema]),
  );
  return z
    .object({
      dimensions: z.object(dimensionShape).strict(),
      flags: z.object(flagShape).strict(),
      summary: z.string(),
    })
    .strict();
}

type ResponsePayload = z.infer<ReturnType<typeof buildResponseValidator>>;

function mapEvidence(evidence: z.infer<typeof EvidenceSchema>[]): Evidence[] {
  return evidence.map((item) => ({
    messageIndex: item.message_index,
    quote: item.quote,
  }));
}

/**
 * Normalizes the validated response into domain results. A dimension is scored
 * as `null` whenever the model flags `insufficient_data` (or leaves the score
 * out), so the aggregation drops it from the weighted average (R6). The rubric
 * order is authoritative; the response object is keyed by id.
 */
function toDomainResults(rubric: Rubric, payload: ResponsePayload): {
  dimensions: DimensionResult[];
  flags: FlagResult[];
} {
  const dimensions = rubric.dimensions.map((dimension): DimensionResult => {
    const raw = payload.dimensions[dimension.id];
    return {
      dimensionId: dimension.id,
      score: raw.insufficient_data ? null : raw.score,
      justification: raw.justification,
      evidence: mapEvidence(raw.evidence),
    };
  });

  const flags = rubric.flags.map((flag): FlagResult => {
    const raw = payload.flags[flag.id];
    return {
      flagId: flag.id,
      triggered: raw.triggered,
      justification: raw.justification,
      evidence: mapEvidence(raw.evidence),
    };
  });

  return { dimensions, flags };
}

export interface EvaluateConversationParams {
  client: LlmClient;
  rubric: Rubric;
  /** The masked, preprocessed conversation to evaluate. */
  conversation: Conversation;
  model: string;
}

/** Output of the single-call orchestration: the aggregated result plus the raw
 * artefacts (rendered prompt, raw response, usage) the API layer needs for the
 * response metadata and the audit trail (R7/R8). */
export interface EvaluationOutput {
  result: EvaluationResult;
  promptVersion: string;
  renderedPrompt: { system: string; user: string };
  rawResponse: unknown;
  tokensIn: number;
  tokensOut: number;
  retries: number;
}

/**
 * Single-call orchestration (R6): render the prompt and JSON Schema from the
 * rubric, ask the LLM for one structured evaluation of every dimension and flag,
 * re-validate the response against the rubric, and aggregate deterministically.
 * No framework — just this function behind a small interface, so alternative
 * strategies can be added later without touching the API or persistence.
 */
export async function evaluateConversation(
  params: EvaluateConversationParams,
): Promise<EvaluationOutput> {
  const { client, rubric, conversation, model } = params;

  const prompt = renderPrompt(rubric, conversation);
  const schema = buildResponseJsonSchema(rubric);
  const validate = buildResponseValidator(rubric).parse;

  const response = await client.evaluateStructured({
    system: prompt.system,
    user: prompt.user,
    schema,
    schemaName: SCHEMA_NAME,
    model,
    validate: (raw) => validate(raw),
  });

  const { dimensions, flags } = toDomainResults(rubric, response.value);
  const result = aggregateEvaluation(rubric, {
    dimensions,
    flags,
    summary: response.value.summary,
  });

  return {
    result,
    promptVersion: prompt.promptVersion,
    renderedPrompt: { system: prompt.system, user: prompt.user },
    rawResponse: response.raw,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    retries: response.retries,
  };
}
