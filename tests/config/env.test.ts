import { describe, it, expect } from 'vitest';
import { parseEnv } from '../../src/config/env.js';

const validSource = { OPENAI_API_KEY: 'sk-test-123' };

describe('parseEnv', () => {
  it('loads with defaults when only the API key is provided', () => {
    const cfg = parseEnv(validSource);
    expect(cfg.OPENAI_API_KEY).toBe('sk-test-123');
    expect(cfg.DEFAULT_MODEL).toBe('gpt-4o-mini');
    expect(cfg.MAX_CONVERSATION_TOKENS).toBe(30_000);
    expect(cfg.LLM_MAX_CONCURRENCY).toBe(5);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.DB_PATH).toBe('./data/evaluations.db');
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  it('coerces numeric values coming from strings', () => {
    const cfg = parseEnv({
      ...validSource,
      MAX_CONVERSATION_TOKENS: '12000',
      LLM_MAX_CONCURRENCY: '3',
      PORT: '8080',
    });
    expect(cfg.MAX_CONVERSATION_TOKENS).toBe(12_000);
    expect(cfg.LLM_MAX_CONCURRENCY).toBe(3);
    expect(cfg.PORT).toBe(8080);
  });

  it('fails with a clear message when OPENAI_API_KEY is missing', () => {
    expect(() => parseEnv({})).toThrow(/OPENAI_API_KEY/);
  });

  it('fails with a clear message when OPENAI_API_KEY is empty', () => {
    expect(() => parseEnv({ OPENAI_API_KEY: '' })).toThrow(/OPENAI_API_KEY/);
  });

  it('fails when a numeric value is invalid', () => {
    expect(() =>
      parseEnv({ ...validSource, MAX_CONVERSATION_TOKENS: 'abc' }),
    ).toThrow(/MAX_CONVERSATION_TOKENS/);
  });

  it('fails for a LOG_LEVEL outside the allowed set', () => {
    expect(() => parseEnv({ ...validSource, LOG_LEVEL: 'verbose' })).toThrow(
      /LOG_LEVEL/,
    );
  });
});
