import { describe, expect, it } from 'vitest';
import {
  createMetricsRegistry,
  httpMetrics,
  jobMetrics,
  metricsAllowed,
  queueDepthGauge,
} from './metrics';

describe('metrics', () => {
  it('counts requests by route template, not URL', async () => {
    const registry = createMetricsRegistry('api');
    const http = httpMetrics(registry);
    http.observe('GET', '/inbox/conversations/:id', 200, 0.03);
    http.observe('GET', '/inbox/conversations/:id', 200, 0.04);
    http.observe('POST', undefined, 404, 0.001);
    const text = await registry.metrics();
    expect(text).toContain(
      'wacrm_http_requests_total{method="GET",route="/inbox/conversations/:id",status="200",service="api"} 2',
    );
    expect(text).toContain('route="unmatched"');
    expect(text).toContain('wacrm_process_cpu_user_seconds_total');
  });

  it('records jobs and queue depth, and survives a Redis error', async () => {
    const registry = createMetricsRegistry('worker');
    const jobs = jobMetrics(registry);
    jobs.finished('outbound-messages', 'completed', 0.2);
    jobs.finished('outbound-messages', 'failed');
    let fail = false;
    queueDepthGauge(registry, async () => {
      if (fail) throw new Error('redis down');
      return { 'outbound-messages': { waiting: 7, active: 1 } };
    });
    let text = await registry.metrics();
    expect(text).toContain(
      'wacrm_jobs_total{queue="outbound-messages",result="failed",service="worker"} 1',
    );
    expect(text).toContain(
      'wacrm_queue_jobs{queue="outbound-messages",state="waiting",service="worker"} 7',
    );
    fail = true;
    text = await registry.metrics();
    expect(text).not.toContain('state="waiting"');
  });

  it('opens metrics only with the token, or outside production without one', () => {
    expect(metricsAllowed(undefined, undefined, false)).toBe(true);
    expect(metricsAllowed(undefined, undefined, true)).toBe(false);
    const token = 'a-long-metrics-token-123';
    expect(metricsAllowed(`Bearer ${token}`, token, true)).toBe(true);
    expect(metricsAllowed('Bearer wrong', token, false)).toBe(false);
    expect(metricsAllowed(undefined, token, false)).toBe(false);
  });
});
