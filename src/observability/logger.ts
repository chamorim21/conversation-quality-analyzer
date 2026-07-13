import { pino, type Logger } from 'pino';

/**
 * Paths redacted from every structured log. Ensures the OpenAI key (and
 * authorization headers) never show up in logs, even if a configuration object
 * is logged by mistake.
 */
const REDACT_PATHS = [
  'OPENAI_API_KEY',
  'openaiApiKey',
  '*.OPENAI_API_KEY',
  'config.OPENAI_API_KEY',
  'req.headers.authorization',
  'headers.authorization',
];

/**
 * Root logger in structured JSON. The level is read from `LOG_LEVEL` directly
 * from the environment (default `info`), without depending on the full env
 * validation, so the logger can be imported in any context (including tests).
 */
export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
});

/** Creates a child logger with fixed bindings (e.g. a correlation ID). */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
