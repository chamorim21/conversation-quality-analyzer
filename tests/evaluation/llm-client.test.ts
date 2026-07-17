import { describe, it, expect, vi } from 'vitest';
import {
  APIConnectionTimeoutError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
} from 'openai';
import { z } from 'zod';
import type OpenAI from 'openai';
import {
  isTransientError,
  runStructuredCall,
  Semaphore,
  LlmError,
  LlmRequestError,
  LlmSchemaError,
  MockLlmClient,
  OpenAiLlmClient,
  type ChatMessage,
  type RawModelCall,
  type StructuredRequest,
} from '../../src/evaluation/llm-client.js';

const payloadSchema = z.object({ value: z.number() });

function request(overrides: Partial<StructuredRequest<{ value: number }>> = {}) {
  return {
    system: 'system',
    user: 'user',
    schema: { type: 'object' },
    schemaName: 'test',
    model: 'gpt-5.4-mini',
    validate: (raw: unknown) => payloadSchema.parse(raw),
    ...overrides,
  } satisfies StructuredRequest<{ value: number }>;
}

/** A sleep stub that records requested delays and resolves immediately, so
 * backoff timing is asserted without waiting. */
function fakeSleep() {
  const delays: number[] = [];
  const sleep = (ms: number) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { delays, sleep };
}

function raw(content: string, tokensIn = 10, tokensOut = 5): RawModelCall {
  return { content, tokensIn, tokensOut };
}

describe('isTransientError', () => {
  it('treats timeouts, rate limits and 5xx as transient', () => {
    expect(isTransientError(new APIConnectionTimeoutError({ message: 't' }))).toBe(true);
    expect(isTransientError(new RateLimitError(429, undefined, 'r', undefined))).toBe(true);
    expect(isTransientError(new InternalServerError(500, undefined, 'e', undefined))).toBe(true);
  });

  it('does not retry client errors (4xx) or generic errors', () => {
    expect(isTransientError(new BadRequestError(400, undefined, 'b', undefined))).toBe(false);
    expect(isTransientError(new Error('boom'))).toBe(false);
  });
});

describe('runStructuredCall retry/backoff', () => {
  it('retries transient failures with exponential backoff, then succeeds', async () => {
    const { delays, sleep } = fakeSleep();
    let attempt = 0;
    const callModel = vi.fn(async (): Promise<RawModelCall> => {
      attempt += 1;
      if (attempt < 3) throw new RateLimitError(429, undefined, 'slow down', undefined);
      return raw(JSON.stringify({ value: 7 }));
    });

    const result = await runStructuredCall(callModel, request(), {
      maxAttempts: 3,
      baseDelayMs: 100,
      sleep,
    });

    expect(callModel).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]); // baseDelay, then 2x
    expect(result.value).toEqual({ value: 7 });
    expect(result.retries).toBe(2);
  });

  it('throws LlmRequestError once transient retries are exhausted', async () => {
    const { sleep } = fakeSleep();
    const callModel = vi.fn(async (): Promise<RawModelCall> => {
      throw new InternalServerError(503, undefined, 'down', undefined);
    });

    await expect(
      runStructuredCall(callModel, request(), { maxAttempts: 3, sleep }),
    ).rejects.toBeInstanceOf(LlmRequestError);
    expect(callModel).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient error', async () => {
    const { sleep } = fakeSleep();
    const callModel = vi.fn(async (): Promise<RawModelCall> => {
      throw new BadRequestError(400, undefined, 'bad', undefined);
    });

    await expect(
      runStructuredCall(callModel, request(), { maxAttempts: 3, sleep }),
    ).rejects.toBeInstanceOf(LlmRequestError);
    expect(callModel).toHaveBeenCalledTimes(1);
  });
});

describe('runStructuredCall re-prompt on invalid schema', () => {
  it('re-prompts exactly once with the validation error, then succeeds', async () => {
    const seen: ChatMessage[][] = [];
    let call = 0;
    const callModel = async (messages: ChatMessage[]): Promise<RawModelCall> => {
      seen.push(messages);
      call += 1;
      return call === 1
        ? raw(JSON.stringify({ wrong: true }))
        : raw(JSON.stringify({ value: 42 }));
    };

    const result = await runStructuredCall(callModel, request(), { sleep: fakeSleep().sleep });

    expect(call).toBe(2);
    expect(result.value).toEqual({ value: 42 });
    expect(result.retries).toBe(1);
    // The re-prompt carries an extra correction message.
    expect(seen[0]).toHaveLength(2);
    expect(seen[1]).toHaveLength(3);
    expect(seen[1][2].content).toMatch(/schema/i);
  });

  it('throws LlmSchemaError with the last raw response when it stays invalid', async () => {
    const callModel = async (): Promise<RawModelCall> => raw(JSON.stringify({ nope: 1 }));

    await expect(
      runStructuredCall(callModel, request(), { sleep: fakeSleep().sleep }),
    ).rejects.toMatchObject({
      name: 'LlmSchemaError',
      lastRaw: JSON.stringify({ nope: 1 }),
    });
  });

  it('treats non-JSON content as a validation failure', async () => {
    const callModel = async (): Promise<RawModelCall> => raw('not json');
    await expect(
      runStructuredCall(callModel, request(), { sleep: fakeSleep().sleep }),
    ).rejects.toBeInstanceOf(LlmSchemaError);
  });
});

describe('Semaphore', () => {
  it('never runs more than the configured number of tasks at once', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];

    const tasks = Array.from({ length: 5 }, () =>
      semaphore.run(
        () =>
          new Promise<void>((resolve) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            release.push(() => {
              active -= 1;
              resolve();
            });
          }),
      ),
    );

    // Let the semaphore admit the first batch.
    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBe(2);

    // Drain: release the running tasks so the queue advances.
    while (release.length) {
      release.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }

    await Promise.all(tasks);
    expect(maxActive).toBe(2);
  });

  it('rejects a capacity below 1', () => {
    expect(() => new Semaphore(0)).toThrow();
  });
});

describe('OpenAiLlmClient', () => {
  /** Minimal fake OpenAI whose `chat.completions.create` returns a scripted
   * completion, so the client's wiring is tested with no API key. */
  function fakeOpenAI(create: (params: unknown) => Promise<unknown>): {
    openai: OpenAI;
    calls: unknown[];
  } {
    const calls: unknown[] = [];
    const wrapped = (params: unknown) => {
      calls.push(params);
      return create(params);
    };
    const openai = { chat: { completions: { create: wrapped } } } as unknown as OpenAI;
    return { openai, calls };
  }

  function client(openai: OpenAI) {
    return new OpenAiLlmClient({
      apiKey: 'unused',
      maxConcurrency: 1,
      openai,
      sleep: () => Promise.resolve(),
    });
  }

  it('maps a completion to the validated value and token usage', async () => {
    const { openai, calls } = fakeOpenAI(async () => ({
      choices: [{ message: { content: JSON.stringify({ value: 9 }) } }],
      usage: { prompt_tokens: 123, completion_tokens: 45 },
    }));

    const result = await client(openai).evaluateStructured(request());

    expect(result.value).toEqual({ value: 9 });
    expect(result.tokensIn).toBe(123);
    expect(result.tokensOut).toBe(45);
    expect(result.retries).toBe(0);

    // Structured output is requested in strict mode with the provided schema.
    const params = calls[0] as {
      model: string;
      response_format: { type: string; json_schema: { name: string; strict: boolean; schema: unknown } };
    };
    expect(params.model).toBe('gpt-5.4-mini');
    expect(params.response_format.type).toBe('json_schema');
    expect(params.response_format.json_schema).toMatchObject({
      name: 'test',
      strict: true,
      schema: { type: 'object' },
    });
  });

  it('fails (no retry) when the model refuses', async () => {
    const create = vi.fn(async () => ({
      choices: [{ message: { content: null, refusal: 'não posso ajudar' } }],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
    }));
    const { openai } = fakeOpenAI(create);

    await expect(client(openai).evaluateStructured(request())).rejects.toBeInstanceOf(LlmError);
    await expect(client(openai).evaluateStructured(request())).rejects.toThrow(/refus/i);
    expect(create).toHaveBeenCalledTimes(2); // once per evaluateStructured call, no retry
  });

  it('fails when the model returns empty content', async () => {
    const { openai } = fakeOpenAI(async () => ({
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
    }));

    await expect(client(openai).evaluateStructured(request())).rejects.toThrow(/empty/i);
  });
});

describe('MockLlmClient', () => {
  it('records calls and validates the programmed response', async () => {
    const client = new MockLlmClient(() => ({ raw: { value: 3 }, tokensIn: 11, tokensOut: 4 }));
    const result = await client.evaluateStructured(request());
    expect(result.value).toEqual({ value: 3 });
    expect(result.tokensIn).toBe(11);
    expect(client.calls).toHaveLength(1);
  });

  it('surfaces a malformed programmed response as a validation error', async () => {
    const client = new MockLlmClient(() => ({ raw: { wrong: true } }));
    await expect(client.evaluateStructured(request())).rejects.toBeInstanceOf(z.ZodError);
  });
});
