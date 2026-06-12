/**
 * Prometheus exposition endpoint (ADR-051, R2 phase 2).
 *
 * A SEPARATE bare node:http server on :9090 serving exactly one path,
 * GET /metrics — deliberately NOT a route on the Fastify app:
 *   * the authenticated app on :3000 stays traefik-ns-only (F4
 *     invariant untouched, no auth special-casing for a scrape path);
 *   * the metrics port gets its own NetworkPolicy
 *     (allow-monitoring-to-platform-api-metrics) scoped to the
 *     monitoring namespace.
 *
 * Also wires the Fastify onResponse hook that feeds the HTTP request
 * histogram (route pattern labels — bounded cardinality).
 */
import http from 'node:http';
import type { FastifyInstance } from 'fastify';
import { metricsRegistry, httpRequestDuration } from '../shared/metrics.js';

export const METRICS_PORT = 9090;

/** Attach the HTTP-histogram hook to the main app. */
export function registerHttpMetricsHook(app: FastifyInstance): void {
  app.addHook('onResponse', (request, reply, done) => {
    try {
      const route = request.routeOptions?.url ?? 'unmatched';
      const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
      httpRequestDuration.observe(
        { method: request.method, route, status_class: statusClass },
        reply.elapsedTime / 1000,
      );
    } catch {
      // Metrics must never break request handling.
    }
    done();
  });
}

/**
 * Start the bare exposition server. Returns an async stop function for
 * the app's onClose hook.
 */
export function startMetricsServer(
  log: { info: (msg: string) => void; warn: (...args: unknown[]) => void },
  port: number = METRICS_PORT,
): () => Promise<void> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/metrics') {
      res.statusCode = 404;
      res.end('not found\n');
      return;
    }
    metricsRegistry
      .metrics()
      .then((body) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', metricsRegistry.contentType);
        res.end(body);
      })
      .catch((err: unknown) => {
        res.statusCode = 500;
        res.end('metrics collection failed\n');
        log.warn('metrics exposition failed:', err instanceof Error ? err.message : String(err));
      });
  });

  server.listen(port, '0.0.0.0', () => {
    log.info(`metrics exposition listening on :${port}/metrics`);
  });
  server.on('error', (err) => {
    // Non-fatal by design: a metrics port clash must never take the
    // API down. The scrape-target-down alert surfaces the gap.
    log.warn('metrics server error (continuing without exposition):', err.message);
  });

  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
