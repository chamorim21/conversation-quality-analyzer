import { loadConfig } from '../config/env.js';
import { OpenAiLlmClient } from '../evaluation/llm-client.js';
import { loadRubrics } from '../rubric/loader.js';
import { logger } from '../observability/logger.js';
import { buildServer } from './server.js';

/**
 * Process entrypoint (`npm run dev` / `npm start`). Fail-fast on boot: config
 * and rubrics are validated before the server starts listening, so a bad
 * environment or rubric never serves a request.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const rubrics = loadRubrics();
  const llmClient = new OpenAiLlmClient({
    apiKey: config.OPENAI_API_KEY,
    maxConcurrency: config.LLM_MAX_CONCURRENCY,
  });

  const app = buildServer({ config, rubrics, llmClient });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'server listening');
}

main().catch((error) => {
  logger.error({ err: error }, 'failed to start server');
  process.exit(1);
});
