import { describe, expect, it } from 'vitest';

import { createOpsModule } from './module';
import { createOpsFakeDeps } from './testing';

describe('createOpsModule', () => {
  it('registers the module under the project name', () => {
    expect(createOpsModule(createOpsFakeDeps()).id).toBe('svc-ops');
  });

  // The action, topic and job generators register into these lists, so the module's own spec does
  // not pin their contents: each registered item has its own spec.
  it('lists its actions, topics and jobs', () => {
    const module = createOpsModule(createOpsFakeDeps());

    expect(Array.isArray(module.actions)).toBe(true);
    expect(Array.isArray(module.topics)).toBe(true);
    expect(Array.isArray(module.jobs)).toBe(true);
  });
});
