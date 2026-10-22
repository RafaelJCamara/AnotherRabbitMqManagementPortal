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
});
