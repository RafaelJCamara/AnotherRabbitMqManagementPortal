import { describe, expect, it } from 'vitest';

import { BlockedState } from './blocked.ts';

describe('BlockedState', () => {
  it('starts unblocked, blocks with the broker reason, and unblocks', () => {
    let clock = 100;
    const state = new BlockedState(() => clock);
    expect(state.isBlocked()).toBe(false);
    expect(state.snapshot()).toEqual({
      blocked: false,
      reason: undefined,
      since: undefined,
    });

    state.block('low on memory');
    clock = 250;
    state.block('low on memory');
    expect(state.isBlocked()).toBe(true);
    // The time the block began is kept while it lasts.
    expect(state.snapshot()).toEqual({
      blocked: true,
      reason: 'low on memory',
      since: 100,
    });

    state.unblock();
    expect(state.isBlocked()).toBe(false);
    expect(state.snapshot().since).toBeUndefined();
  });

  it('cleans and shortens the reason', () => {
    const state = new BlockedState();
    state.block(`bad\u0000text ${'y'.repeat(500)}`);
    const { reason } = state.snapshot();
    expect(reason?.startsWith('bad text')).toBe(true);
    expect(reason?.length).toBeLessThan(210);
  });
});
