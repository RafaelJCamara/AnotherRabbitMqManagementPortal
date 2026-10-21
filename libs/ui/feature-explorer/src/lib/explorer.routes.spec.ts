import { describe, expect, it } from 'vitest';

import { explorerRoutes } from './explorer.routes';

describe('explorerRoutes', () => {
  it('has one parent that provides the explorer scope and a lazy overview at the empty path', () => {
    expect(explorerRoutes).toHaveLength(1);
    const parent = explorerRoutes[0];
    expect(parent?.path).toBe('');
    expect(parent?.providers).toHaveLength(1);
    expect(parent?.children?.[0]?.path).toBe('');
    expect(parent?.children?.[0]?.loadComponent).toBeTypeOf('function');
  });
});
