import { describe, expect, it } from 'vitest';

import { createExplorerModule } from './module';
import { createExplorerFakeDeps } from './testing';

describe('createExplorerModule', () => {
  it('registers the module under the project name', () => {
    expect(createExplorerModule(createExplorerFakeDeps()).id).toBe(
      'svc-explorer',
    );
  });

  // The action, topic and job generators register into these lists, so the module's own spec does
  // not pin their contents: each registered item has its own spec.
  it('lists its actions, topics and jobs', () => {
    const module = createExplorerModule(createExplorerFakeDeps());

    expect(Array.isArray(module.actions)).toBe(true);
    expect(Array.isArray(module.topics)).toBe(true);
    expect(Array.isArray(module.jobs)).toBe(true);
  });
});
