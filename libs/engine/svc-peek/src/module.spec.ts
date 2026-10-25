import { describe, expect, it } from 'vitest';

import { createPeekModule } from './module';
import { createPeekFakeDeps } from './testing';

describe('createPeekModule', () => {
  it('registers the module under the project name', () => {
    expect(createPeekModule(createPeekFakeDeps()).id).toBe('svc-peek');
  });

  // The action, topic and job generators register into these lists, so the module's own spec does
  // not pin their contents: each registered item has its own spec.
  it('lists its actions, topics and jobs', () => {
    const module = createPeekModule(createPeekFakeDeps());

    expect(Array.isArray(module.actions)).toBe(true);
    expect(Array.isArray(module.topics)).toBe(true);
    expect(Array.isArray(module.jobs)).toBe(true);
  });
});
