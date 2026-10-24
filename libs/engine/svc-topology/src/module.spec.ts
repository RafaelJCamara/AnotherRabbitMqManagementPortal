import { describe, expect, it } from 'vitest';

import { createTopologyModule } from './module';
import { createTopologyFakeDeps } from './testing';

describe('createTopologyModule', () => {
  it('registers the module under the project name', () => {
    expect(createTopologyModule(createTopologyFakeDeps()).id).toBe(
      'svc-topology',
    );
  });

  it('lists its actions, topics and jobs', () => {
    const module = createTopologyModule(createTopologyFakeDeps());

    expect(module.actions.length).toBeGreaterThan(0);
    expect(module.topics).toEqual([]);
    expect(module.jobs).toEqual([]);
  });
});

describe('M1-20 AC-12 the module is read only', () => {
  const module = createTopologyModule(createTopologyFakeDeps());

  it('declares every action a query on broker.read with no plan, no risk and no audit', () => {
    for (const impl of module.actions) {
      expect(impl.def.kind, impl.def.id).toBe('query');
      expect(impl.def.permission, impl.def.id).toBe('broker.read');
      expect(impl.def.risk, impl.def.id).toBe('none');
      expect(impl.def.planning, impl.def.id).toBe('none');
      expect(impl.def.audit, impl.def.id).toBe('none');
      expect('plan' in impl, impl.def.id).toBe(false);
      expect('revalidate' in impl, impl.def.id).toBe(false);
    }
  });

  it('is handed a management port that can only read, and nothing that can write', () => {
    const deps = createTopologyFakeDeps();
    expect(Object.keys(deps.mgmt).sort()).toEqual(['get', 'stream']);
    expect(Object.keys(deps).sort()).toEqual(
      [
        'broker',
        'clock',
        'connections',
        'mgmt',
        'profiles',
        'snapshots',
        'yieldNow',
        'yields',
      ].sort(),
    );
  });

  it('drops its snapshots when it stops', () => {
    expect(() => {
      createTopologyModule(createTopologyFakeDeps()).stop();
    }).not.toThrow();
  });
});
