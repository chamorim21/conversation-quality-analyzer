import type { FastifyInstance } from 'fastify';
import { computeMetrics } from '../../observability/metrics.js';
import type { ServerDeps } from '../server.js';

/**
 * `GET /metrics` — aggregated operational metrics computed from the SQLite audit
 * trail (R10): totals, error rate, accumulated and per-evaluation cost, tokens,
 * latency p50/p95, score distribution per dimension/rubric-version, and flag
 * counts.
 */
export function registerMetricsRoute(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/metrics', async () => computeMetrics(deps.repository.getMetricsData()));
}
