import { z } from 'zod';

/**
 * Environment variable schema. Numeric values are coerced from strings (as the
 * process hands them over) and get sensible defaults, except the OpenAI key,
 * which is required.
 */
const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'required'),
  DEFAULT_MODEL: z.string().min(1).default('gpt-4o-mini'),
  MAX_CONVERSATION_TOKENS: z.coerce.number().int().positive().default(30_000),
  LLM_MAX_CONCURRENCY: z.coerce.number().int().positive().default(5),
  PORT: z.coerce.number().int().positive().default(3000),
  DB_PATH: z.string().min(1).default('./data/evaluations.db'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * Validates a source of environment variables. Throws an error listing every
 * problem (fail-fast) when the configuration is invalid.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

let cached: AppConfig | null = null;

/**
 * Loads and validates the configuration from `process.env` exactly once
 * (memoized). Should be called at boot to guarantee fail-fast before serving
 * any requests.
 */
export function loadConfig(): AppConfig {
  if (cached === null) {
    cached = parseEnv();
  }
  return cached;
}
