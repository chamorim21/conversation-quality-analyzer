import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { ServerDeps } from '../server.js';

/**
 * `GET /health` — process liveness plus SQLite reachability (R10). Returns 200
 * only when the audit database answers a probe query; a `503` is returned when
 * it is unreachable, so a broken persistence layer (which is on the critical
 * path) is never reported as healthy. A failed probe is logged (with the
 * correlation id) so an operator has a diagnostic trail, not just a bare 503.
 */
export function registerHealthRoute(
  app: FastifyInstance,
  deps: ServerDeps,
  rootLogger: Logger,
): void {
  app.get('/health', async (request, reply) => {
    try {
      deps.repository.ping();
      return { status: 'ok' };
    } catch (error) {
      rootLogger
        .child({ correlationId: request.correlationId })
        .error({ err: error }, 'health check failed: database unreachable');
      reply.status(503).send({ status: 'error', detail: 'database unavailable' });
    }
  });
}
