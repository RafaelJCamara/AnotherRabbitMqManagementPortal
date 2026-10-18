import { describe, expect, it } from 'vitest';

import { migrations } from './index';

describe('migrations', () => {
  it('are numbered 0001, 0002, ... without gaps, in order', () => {
    const numbers = migrations.map((migration) => migration.id.slice(0, 4));

    expect(numbers).toEqual(
      migrations.map((_, index) => String(index + 1).padStart(4, '0')),
    );
  });

  it('have ids of the form NNNN_name', () => {
    for (const migration of migrations) {
      expect(migration.id).toMatch(/^\d{4}_[a-z0-9_]+$/);
    }
  });
});
