import { describe, expect, it } from 'vitest';

import { explorerRoutes } from './explorer.routes';

describe('explorerRoutes', () => {
  it('has one parent that provides the explorer scope, a lazy overview and one lazy grid per kind', () => {
    expect(explorerRoutes).toHaveLength(1);
    const parent = explorerRoutes[0];
    expect(parent?.path).toBe('');
    expect(parent?.providers).toHaveLength(1);
    const children = parent?.children ?? [];
    expect(children.map((c) => c.path)).toEqual([
      '',
      'queues',
      'exchanges',
      'connections',
      'bindings',
    ]);
    for (const child of children) {
      expect(child.loadComponent).toBeTypeOf('function');
    }
    expect(children.slice(1).map((c) => c.data)).toEqual([
      { kind: 'queues' },
      { kind: 'exchanges' },
      { kind: 'connections' },
      { kind: 'bindings' },
    ]);
  });
});
