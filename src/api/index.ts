import { loadConfig } from '../config/env.js';
import { assertModelSupported } from '../config/models.js';
import { OpenAiLlmClient } from '../evaluation/llm-client.js';
import { loadRubrics } from '../rubric/loader.js';
import { logger } from '../observability/logger.js';
import { openDatabase } from '../persistence/db.js';
import { createEvaluationRepository } from '../persistence/repository.js';
import { buildServer } from './server.js';

/**
 * Process entrypoint (`npm run dev` / `npm start`). Fail-fast on boot: config,
 * rubrics, and the database (open + migrations) are all validated before the
 * server starts listening, so a bad environment, rubric, or DB never serves a
 * request.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  // Fail-fast: the default model must be known and its context window must fit
  // MAX_CONVERSATION_TOKENS + the fixed reserve, or the process must not start.
  assertModelSupported(config.DEFAULT_MODEL, config.MAX_CONVERSATION_TOKENS);
  const rubrics = loadRubrics();
  const db = openDatabase(config.DB_PATH);
  const repository = createEvaluationRepository(db);
  const llmClient = new OpenAiLlmClient({
    apiKey: config.OPENAI_API_KEY,
    maxConcurrency: config.LLM_MAX_CONCURRENCY,
  });

  const app = buildServer({ config, rubrics, llmClient, repository });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'server listening');
}

main().catch((error) => {
  logger.error({ err: error }, 'failed to start server');
  process.exit(1);
});
