/**
 * Prometheus metrics for the API and worker (Phase 4.5). Each process keeps its own registry with
 * the default process metrics (CPU, memory, event loop lag, GC) plus a few of its own. Names are
 * prefixed `wacrm_`; dashboards and alert rules in `infra/observability` read them.
 *
 * Labels stay low-cardinality on purpose: HTTP routes are the route template (`/inbox/:id`), never
 * the URL, and nothing is labelled by workspace, user or phone number.
 */
import { timingSafeEqual } from 'node:crypto';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export type MetricsRegistry = Registry;

export function createMetricsRegistry(service: 'api' | 'worker'): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry, prefix: 'wacrm_' });
  return registry;
}

/** Request counts and latency by method, route template and status class. */
export function httpMetrics(registry: Registry) {
  const requests = new Counter({
    name: 'wacrm_http_requests_total',
    help: 'HTTP requests answered, by method, route template and status.',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'wacrm_http_request_duration_seconds',
    help: 'HTTP request duration, by method and route template.',
    labelNames: ['method', 'route'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  return {
    observe(method: string, route: string | undefined, status: number, seconds: number) {
      const r = route ?? 'unmatched';
      requests.inc({ method, route: r, status: String(status) });
      duration.observe({ method, route: r }, seconds);
    },
  };
}

/** Finished jobs and their duration, by queue and result. */
export function jobMetrics(registry: Registry) {
  const jobs = new Counter({
    name: 'wacrm_jobs_total',
    help: 'Background jobs finished, by queue and result (completed or failed).',
    labelNames: ['queue', 'result'] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'wacrm_job_duration_seconds',
    help: 'Background job run time, by queue.',
    labelNames: ['queue'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
    registers: [registry],
  });
  return {
    finished(queue: string, result: 'completed' | 'failed', seconds?: number) {
      jobs.inc({ queue, result });
      if (seconds !== undefined && seconds >= 0) duration.observe({ queue }, seconds);
    },
  };
}

export type QueueCounts = Record<string, Record<string, number>>;

/**
 * Jobs per queue and state (waiting, active, delayed, failed, ...), read from Redis when scraped.
 * A Redis error leaves the gauge empty for that scrape rather than failing the whole page.
 */
export function queueDepthGauge(registry: Registry, read: () => Promise<QueueCounts>) {
  return new Gauge({
    name: 'wacrm_queue_jobs',
    help: 'Jobs in each queue, by state.',
    labelNames: ['queue', 'state'] as const,
    registers: [registry],
    async collect() {
      this.reset();
      let counts: QueueCounts;
      try {
        counts = await read();
      } catch {
        return;
      }
      for (const [queue, states] of Object.entries(counts)) {
        for (const [state, n] of Object.entries(states)) this.set({ queue, state }, n);
      }
    },
  });
}

/**
 * Whether a scrape may read the metrics. With `METRICS_TOKEN` set, it needs that bearer token.
 * Without one, metrics are open outside production and closed in production.
 */
export function metricsAllowed(
  authorization: string | undefined,
  token: string | undefined,
  production: boolean,
): boolean {
  if (!token) return !production;
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(authorization ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
