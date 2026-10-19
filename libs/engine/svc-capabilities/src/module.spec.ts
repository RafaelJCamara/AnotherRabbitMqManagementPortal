import { describe, expect, it } from 'vitest';

import { createCapabilitiesModule } from './module';
import { createCapabilitiesFakeDeps } from './testing';

describe('createCapabilitiesModule', () => {
  it('registers the module under the project name', () => {
    expect(createCapabilitiesModule(createCapabilitiesFakeDeps()).id).toBe(
      'svc-capabilities',
    );
  });

  // The action, topic and job generators register into these lists, so the module's own spec does
  // not pin their contents: each registered item has its own spec.
  it('lists its actions, topics and jobs', () => {
    const module = createCapabilitiesModule(createCapabilitiesFakeDeps());

    expect(Array.isArray(module.actions)).toBe(true);
    expect(Array.isArray(module.topics)).toBe(true);
    expect(Array.isArray(module.jobs)).toBe(true);
  });
});
