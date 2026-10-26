import { describe, expect, it } from 'vitest';

import { createIdentityModule } from './module';
import { createIdentityFakeDeps } from './testing';

describe('createIdentityModule', () => {
  it('registers the module under the project name', () => {
    expect(createIdentityModule(createIdentityFakeDeps()).id).toBe(
      'svc-identity',
    );
  });

  // The action, topic and job generators register into these lists, so the module's own spec does
  // not pin their contents: each registered item has its own spec.
  it('lists its actions, topics and jobs', () => {
    const module = createIdentityModule(createIdentityFakeDeps());

    expect(Array.isArray(module.actions)).toBe(true);
    expect(Array.isArray(module.topics)).toBe(true);
    expect(Array.isArray(module.jobs)).toBe(true);
  });
});
