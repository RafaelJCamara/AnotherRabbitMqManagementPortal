import { describe, expect, it } from 'vitest';

import { createMessagesModule } from './module';
import { createMessagesFakeDeps } from './testing';

describe('createMessagesModule', () => {
  it('registers the module under the project name', () => {
    expect(createMessagesModule(createMessagesFakeDeps()).id).toBe(
      'svc-messages',
    );
  });

  // The action, topic and job generators register into these lists, so the module's own spec does
  // not pin their contents: each registered item has its own spec.
  it('lists its actions, topics and jobs', () => {
    const module = createMessagesModule(createMessagesFakeDeps());

    expect(Array.isArray(module.actions)).toBe(true);
    expect(Array.isArray(module.topics)).toBe(true);
    expect(Array.isArray(module.jobs)).toBe(true);
  });
});
