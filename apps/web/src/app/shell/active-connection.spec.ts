import { describe, expect, it } from 'vitest';

import { ActiveConnection, parseConnectionParam } from './active-connection';

describe('parseConnectionParam', () => {
  it('accepts plain tokens, ULIDs and UUIDs', () => {
    for (const ok of [
      'c1',
      'prod-eu.1',
      '01J8ZK3V5N6Q7R8S9T0V1W2X3Y',
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'a'.repeat(128),
    ]) {
      expect(parseConnectionParam(ok)).toBe(ok);
    }
  });

  it('rejects anything that is not a plain route token', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'not an id',
      '-leading',
      '.hidden',
      'a/b',
      '..',
      'x?y',
      'x#y',
      'javascript:alert(1)',
      'tab\tid',
      'a'.repeat(129),
      'é',
    ]) {
      expect(parseConnectionParam(bad)).toBeNull();
    }
  });
});

describe('ActiveConnection', () => {
  it('starts unset and exposes the selection read-only', () => {
    const connection = new ActiveConnection();
    expect(connection.cid()).toBeNull();
    connection.select(parseConnectionParam('c1'));
    expect(connection.cid()).toBe('c1');
    connection.select(null);
    expect(connection.cid()).toBeNull();
    expect('set' in connection.cid).toBe(false);
  });
});
