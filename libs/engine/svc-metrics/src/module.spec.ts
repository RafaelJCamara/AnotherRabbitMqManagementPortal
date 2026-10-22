import { metricsQuery } from '@app/contracts';
import { createTestContext, createTestExecutor } from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { createMetricsModule } from './module';
import { createMetricsFakeDeps } from './testing';

describe('createMetricsModule', () => {
  it('registers the module under the project name', () => {
    expect(createMetricsModule(createMetricsFakeDeps()).id).toBe('svc-metrics');
  });

  // The action, topic and job generators register into these lists, so the module's own spec does
  // not pin their contents: each registered item has its own spec.
  it('lists its actions, topics and jobs', () => {
    const module = createMetricsModule(createMetricsFakeDeps());

    expect(Array.isArray(module.actions)).toBe(true);
    expect(Array.isArray(module.topics)).toBe(true);
    expect(Array.isArray(module.jobs)).toBe(true);
  });

  it('AC-18 stop ends the collection: nothing is requested after it', async () => {
    const fakes = createMetricsFakeDeps();
    const module = createMetricsModule(fakes);
    const engine = createTestExecutor();
    engine.executor.register(...module.actions);
    await engine.executor.run(
      metricsQuery,
      { cid: 'c1', series: [{ metric: 'messages_ready' }] },
      createTestContext(),
    );
    await fakes.timers.settle();
    const before = fakes.promScript.requests.length;
    expect(before).toBeGreaterThan(0);

    await module.stop();
    await fakes.timers.advance(600_000);
    expect(fakes.promScript.requests).toHaveLength(before);
    expect(fakes.timers.pending()).toBe(0);
  });
});
