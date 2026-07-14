import OpenAI, { APIError } from 'openai';
import type { JsonSchema } from '../rubric/json-schema.js';

/**
 * A single structured-output request: the two prompt messages, the JSON Schema
 * the model must conform to, and a `validate` callback that turns the raw parsed
 * response into a typed value (throwing on anything the caller considers invalid,
 * e.g. a Zod parse failure). Keeping validation in the caller's hands is what
 * lets this layer own the single re-prompt on a schema violation (R9) while the
 * orchestrator owns the rubric-derived schema.
 */
export interface StructuredRequest<T> {
  system: string;
  user: string;
  schema: JsonSchema;
  /** Name for the schema, sent to OpenAI structured outputs (must be a slug). */
  schemaName: string;
  model: string;
  validate: (raw: unknown) => T;
}

/** Outcome of a structured call: the validated value plus the raw response and
 * usage/retry counters needed for the response metadata and the audit trail
 * (R7/R8). */
export interface StructuredResponse<T> {
  value: T;
  raw: unknown;
  tokensIn: number;
  tokensOut: number;
  retries: number;
}

/** Small chat interface a client must implement. The orchestrator depends on
 * this, not on OpenAI, so tests run against {@link MockLlmClient} with no API
 * key (SPEC testing strategy). */
export interface LlmClient {
  evaluateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>>;
}

/** Base error for every LLM-layer failure. The API maps it to a `502`. */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Raised after the transient-error retries are exhausted (R9). */
export class LlmRequestError extends LlmError {
  constructor(
    public readonly attempts: number,
    cause: unknown,
  ) {
    super(`LLM request failed after ${attempts} attempt(s): ${describe(cause)}`, cause);
    this.name = 'LlmRequestError';
  }
}

/** Raised when the response still fails validation after the single re-prompt
 * (R9). Carries the last raw response so it can be persisted for analysis. */
export class LlmSchemaError extends LlmError {
  constructor(
    public readonly lastRaw: unknown,
    cause: unknown,
  ) {
    super(`LLM response failed schema validation after re-prompt: ${describe(cause)}`, cause);
    this.name = 'LlmSchemaError';
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Sleeps `ms` milliseconds. Injectable so retry timing is testable with fake
 * timers or a stub. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Counting semaphore. Caps how many `run` bodies execute concurrently, so the
 * process never issues more simultaneous OpenAI calls than
 * `LLM_MAX_CONCURRENCY` (R9); requests over the limit queue instead of
 * overwhelming the provider's rate limit.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    if (max < 1) throw new Error(`Semaphore capacity must be >= 1, got ${max}`);
    this.available = max;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available += 1;
    }
  }
}

/** Whether an error from the OpenAI SDK is worth retrying: timeouts, rate
 * limits, and 5xx server errors are transient; 4xx (bad request, auth) are not
 * (R9). */
export function isTransientError(error: unknown): boolean {
  if (error instanceof APIError) {
    const status = error.status;
    // Connection/timeout errors surface with no status.
    return status === undefined || status === 408 || status === 429 || status >= 500;
  }
  return false;
}

/** One low-level model call: prompt messages in, raw text content + usage out.
 * The real client wires this to OpenAI; tests supply a stub. */
export type ModelCall = (messages: ChatMessage[]) => Promise<RawModelCall>;

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface RawModelCall {
  content: string;
  tokensIn: number;
  tokensOut: number;
}

export interface RunStructuredCallOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: Sleep;
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Shared control flow behind every structured call, independent of OpenAI so it
 * can be unit-tested with a stub `callModel`:
 *  1. call the model, retrying transient failures with exponential backoff
 *     (`maxAttempts` total tries);
 *  2. parse the JSON and run `validate`;
 *  3. on a validation failure, re-prompt exactly once with the error appended,
 *     then give up with an {@link LlmSchemaError}.
 * `retries` in the result counts the extra attempts beyond the first, across
 * both transient retries and the re-prompt.
 */
export async function runStructuredCall<T>(
  callModel: ModelCall,
  request: StructuredRequest<T>,
  options: RunStructuredCallOptions = {},
): Promise<StructuredResponse<T>> {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    sleep = realSleep,
    isRetryable = isTransientError,
  } = options;

  let extraAttempts = 0;

  const messages: ChatMessage[] = [
    { role: 'system', content: request.system },
    { role: 'user', content: request.user },
  ];

  // First pass: obtain a raw response, retrying only transient transport errors.
  const first = await callWithRetry(callModel, messages, {
    maxAttempts,
    baseDelayMs,
    sleep,
    isRetryable,
    onRetry: () => {
      extraAttempts += 1;
    },
  });

  const firstParsed = tryValidate(first.content, request.validate);
  if (firstParsed.ok) {
    return {
      value: firstParsed.value,
      raw: firstParsed.raw,
      tokensIn: first.tokensIn,
      tokensOut: first.tokensOut,
      retries: extraAttempts,
    };
  }

  // Single re-prompt: hand the validation error back to the model and try once
  // more (R9). Transient errors on the re-prompt are still retried.
  extraAttempts += 1;
  const retryMessages: ChatMessage[] = [
    ...messages,
    { role: 'user', content: correctionPrompt(first.content, firstParsed.error) },
  ];
  const second = await callWithRetry(callModel, retryMessages, {
    maxAttempts,
    baseDelayMs,
    sleep,
    isRetryable,
    onRetry: () => {
      extraAttempts += 1;
    },
  });

  const secondParsed = tryValidate(second.content, request.validate);
  if (!secondParsed.ok) {
    throw new LlmSchemaError(second.content, secondParsed.error);
  }
  return {
    value: secondParsed.value,
    raw: secondParsed.raw,
    tokensIn: second.tokensIn,
    tokensOut: second.tokensOut,
    retries: extraAttempts,
  };
}

interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  sleep: Sleep;
  isRetryable: (error: unknown) => boolean;
  onRetry: () => void;
}

async function callWithRetry(
  callModel: ModelCall,
  messages: ChatMessage[],
  config: RetryConfig,
): Promise<RawModelCall> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      return await callModel(messages);
    } catch (error) {
      lastError = error;
      const canRetry = attempt < config.maxAttempts && config.isRetryable(error);
      if (!canRetry) break;
      config.onRetry();
      // Exponential backoff: baseDelay, 2×, 4×, ...
      await config.sleep(config.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw new LlmRequestError(config.maxAttempts, lastError);
}

type ValidationOutcome<T> =
  | { ok: true; value: T; raw: unknown }
  | { ok: false; error: unknown };

function tryValidate<T>(content: string, validate: (raw: unknown) => T): ValidationOutcome<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    return { ok: false, error };
  }
  try {
    return { ok: true, value: validate(raw), raw };
  } catch (error) {
    return { ok: false, error };
  }
}

function correctionPrompt(previous: string, error: unknown): string {
  return [
    'Sua resposta anterior não obedeceu ao formato exigido e foi rejeitada.',
    `Erro de validação: ${describe(error)}`,
    'Resposta anterior:',
    previous,
    'Reescreva a resposta corrigindo o problema e obedecendo estritamente ao schema solicitado.',
  ].join('\n');
}

export interface OpenAiLlmClientOptions {
  apiKey: string;
  /** Max concurrent OpenAI calls in this process (`LLM_MAX_CONCURRENCY`). */
  maxConcurrency: number;
  temperature?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Injectable OpenAI instance and sleep, for tests. */
  openai?: OpenAI;
  sleep?: Sleep;
}

/**
 * OpenAI-backed {@link LlmClient}. Uses structured outputs (strict JSON Schema),
 * bounds concurrency with a {@link Semaphore}, and delegates retry/backoff and
 * the single re-prompt to {@link runStructuredCall}. The API key is only read
 * from config and never logged.
 */
export class OpenAiLlmClient implements LlmClient {
  private readonly client: OpenAI;
  private readonly semaphore: Semaphore;
  private readonly temperature: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: Sleep;

  constructor(options: OpenAiLlmClientOptions) {
    this.client = options.openai ?? new OpenAI({ apiKey: options.apiKey });
    this.semaphore = new Semaphore(options.maxConcurrency);
    this.temperature = options.temperature ?? 0;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.sleep = options.sleep ?? realSleep;
  }

  evaluateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    return this.semaphore.run(() =>
      runStructuredCall(
        (messages) => this.callModel(request, messages),
        request,
        {
          maxAttempts: this.maxAttempts,
          baseDelayMs: this.baseDelayMs,
          sleep: this.sleep,
        },
      ),
    );
  }

  private async callModel(
    request: StructuredRequest<unknown>,
    messages: ChatMessage[],
  ): Promise<RawModelCall> {
    const completion = await this.client.chat.completions.create({
      model: request.model,
      temperature: this.temperature,
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName,
          schema: request.schema,
          strict: true,
        },
      },
    });

    const choice = completion.choices[0];
    if (choice?.message.refusal) {
      throw new LlmError(`Model refused to answer: ${choice.message.refusal}`);
    }
    const content = choice?.message.content;
    if (!content) {
      throw new LlmError('Model returned an empty response');
    }
    return {
      content,
      tokensIn: completion.usage?.prompt_tokens ?? 0,
      tokensOut: completion.usage?.completion_tokens ?? 0,
    };
  }
}

/** A programmed reply for {@link MockLlmClient}. */
export interface MockResponse {
  raw: unknown;
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * Deterministic {@link LlmClient} for tests: a `responder` maps each request to
 * a raw response, which is then run through the request's own `validate` so the
 * mock honours the same contract as the real client (a malformed programmed
 * response surfaces as a validation error, not a silent pass). Records every
 * request in `calls`.
 */
export class MockLlmClient implements LlmClient {
  readonly calls: StructuredRequest<unknown>[] = [];

  constructor(
    private readonly responder: (
      request: StructuredRequest<unknown>,
    ) => MockResponse | Promise<MockResponse>,
  ) {}

  async evaluateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    this.calls.push(request);
    const response = await this.responder(request);
    return {
      value: request.validate(response.raw),
      raw: response.raw,
      tokensIn: response.tokensIn ?? 0,
      tokensOut: response.tokensOut ?? 0,
      retries: 0,
    };
  }
}
