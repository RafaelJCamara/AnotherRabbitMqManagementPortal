import { describe, expect, it } from 'vitest';

import { createConnectionsModule } from './module';
import { createConnectionsFakeDeps } from './testing';

describe('createConnectionsModule', () => {
  it('registers the module under the project name', () => {
    expect(createConnectionsModule(createConnectionsFakeDeps()).id).toBe(
      'svc-connections',
    );
  });

  it('registers the nine actions of the connections work package (M0-44)', () => {
    const module = createConnectionsModule(createConnectionsFakeDeps());

    expect(
      module.actions
        .map((action) => (action as { def: { id: string } }).def.id)
        .sort(),
    ).toEqual([
      'bundles.export',
      'bundles.import',
      'connections.create',
      'connections.delete',
      'connections.get',
      'connections.list',
      'connections.test-amqp',
      'connections.test-http',
      'connections.update',
    ]);
  });

  // The topic and job generators register into these lists, so the module's own spec does not pin
  // their contents: each registered item has its own spec.
  it('lists its actions, topics and jobs', () => {
    const module = createConnectionsModule(createConnectionsFakeDeps());

    expect(Array.isArray(module.actions)).toBe(true);
    expect(Array.isArray(module.topics)).toBe(true);
    expect(Array.isArray(module.jobs)).toBe(true);
  });
});
