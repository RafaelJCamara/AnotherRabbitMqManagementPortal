import { explorerWindowTopic } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { SUB_KEYS_MAX } from './inventory-model';
import { fitKeys, SUB_KEYS_BYTES_MAX } from './key-budget';
import { createFakeExplorerData } from './testing';
import { createInventoryWindowSource } from './window-source';

const CLIENT_FRAME_MAX = 64 * 1024; // the hub closes the connection over this (OQ-683)

function keyOf(length: number, i: number): string {
  return String(i).padStart(6, '0').padEnd(length, 'x');
}

/** The `sub` frame the live client would send for these keys. */
function subFrame(keys: readonly string[]): string {
  return JSON.stringify({
    t: 'sub',
    sid: 64,
    topic: explorerWindowTopic.id,
    params: { cid: 'a-connection-id', kind: 'queues', keys },
    credit: 16,
  });
}

describe('fitKeys', () => {
  it('AC-8 a sub never exceeds the client frame and the rows left out are counted', () => {
    // 500 keys of 682 characters (a 255-character vhost and name) would be about 340 KB.
    const ids = Array.from({ length: 500 }, (_, i) => keyOf(682, i));
    const { keys, unfollowed } = fitKeys(ids);
    expect(subFrame(ids).length).toBeGreaterThan(CLIENT_FRAME_MAX); // the problem, measured
    const bytes = keys.reduce((n, k) => n + k.length + 3, 0);
    expect(bytes).toBeLessThanOrEqual(SUB_KEYS_BYTES_MAX);
    expect(subFrame(keys).length).toBeLessThan(CLIENT_FRAME_MAX);
    // The earliest ids on screen are kept; the rest is counted, never dropped silently.
    expect(keys).toEqual(ids.slice(0, keys.length));
    expect(keys.length).toBeGreaterThan(0);
    expect(unfollowed).toBe(500 - keys.length);
    // One more key would not have fitted.
    expect(bytes + 682 + 3).toBeGreaterThan(SUB_KEYS_BYTES_MAX);

    // 60 ids of 686 characters fit whole (the interim cut of the spec).
    const sixty = Array.from({ length: 60 }, (_, i) => keyOf(686, i));
    const fitted = fitKeys(sixty);
    expect(fitted.keys).toEqual(sixty);
    expect(fitted.unfollowed).toBe(0);
    expect(subFrame(fitted.keys).length).toBeLessThan(CLIENT_FRAME_MAX);

    // Short keys are bounded by the count, a key longer than the contract allows is never sent.
    const short = fitKeys(
      Array.from({ length: SUB_KEYS_MAX + 7 }, (_, i) => `k${String(i)}`),
    );
    expect(short.keys).toHaveLength(SUB_KEYS_MAX);
    expect(short.unfollowed).toBe(7);
    const odd = fitKeys(['a', 'x'.repeat(1025), 'b']);
    expect(odd.keys).toEqual(['a', 'b']);
    expect(odd.unfollowed).toBe(1);
  });

  it('AC-8 the window source sends only what fits and says how many it left out', () => {
    const data = createFakeExplorerData();
    const source = createInventoryWindowSource(data, {
      cid: 'c1',
      kind: 'queues',
      filter: {},
    });
    const ids = Array.from({ length: 500 }, (_, i) => keyOf(682, i));
    source.watch(new Set(ids));
    const sent = data.followers[0]?.params.keys ?? [];
    expect(subFrame(sent).length).toBeLessThan(CLIENT_FRAME_MAX);
    expect(sent).toEqual(ids.slice(0, sent.length));
    expect(source.state().followed).toBe(sent.length);
    expect(source.state().unfollowed).toBe(500 - sent.length);
  });
});
