import type { FastifyInstance } from 'fastify';

/**
 * `GET /health` — process liveness (R10). This is intentionally minimal for the
 * MVP; the SQLite reachability check is added with persistence in a later task.
 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/health', async () => ({ status: 'ok' }));
}
