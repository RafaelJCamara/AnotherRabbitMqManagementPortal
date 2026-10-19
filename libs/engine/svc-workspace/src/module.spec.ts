import { describe, expect, it } from 'vitest';

import { createWorkspaceModule } from './module';
import { createWorkspaceFakeDeps } from './testing';

describe('createWorkspaceModule', () => {
  it('registers the module under the project name', () => {
    expect(createWorkspaceModule(createWorkspaceFakeDeps()).id).toBe(
      'svc-workspace',
    );
  });

  // The action, topic and job generators register into these lists, so the module's own spec does
  // not pin their contents: each registered item has its own spec.
  it('lists its actions, topics and jobs', () => {
    const module = createWorkspaceModule(createWorkspaceFakeDeps());

    expect(Array.isArray(module.actions)).toBe(true);
    expect(Array.isArray(module.topics)).toBe(true);
    expect(Array.isArray(module.jobs)).toBe(true);
  });
});
