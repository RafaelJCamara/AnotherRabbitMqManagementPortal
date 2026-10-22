import { describe, expect, it } from 'vitest';

import {
  ENTITY_TAB_IDS,
  resolveTab,
  tabSetFor,
  type EntityTabSpec,
} from './entity-tabs';

const ids = (set: readonly EntityTabSpec[]): string[] =>
  set.map((tab) => tab.id);

describe('entity tab sets (R2)', () => {
  it('AC-2 a stream replaces Messages with Browse and every tab names its gate and whether it is built', () => {
    const queue = tabSetFor('queues', { type: 'quorum' });
    const classic = tabSetFor('queues', { type: 'classic' });
    const unknown = tabSetFor('queues', null);
    const stream = tabSetFor('queues', { type: 'stream' });
    const exchange = tabSetFor('exchanges', null);

    expect(ids(queue)).toEqual([
      'overview',
      'messages',
      'publish',
      'tap',
      'consumers',
      'routing',
      'config',
      'charts',
      'forecast',
      'lint',
    ]);
    expect(classic).toBe(queue);
    expect(unknown).toBe(queue);
    // A stream has Browse and no Messages: no tab of its set can get a message.
    expect(ids(stream)).toEqual([
      'overview',
      'browse',
      'consumers',
      'routing',
      'config',
    ]);
    expect(ids(stream)).not.toContain('messages');
    expect(ids(exchange)).toEqual(['overview', 'publish', 'routing', 'config']);
    expect(ids(tabSetFor('connections', null))).toEqual(['overview']);
    expect(ids(tabSetFor('bindings', null))).toEqual(['overview']);

    // What is built in this version, and the gate of each tab that needs one.
    const everything = [...queue, ...stream, ...exchange];
    const built = new Set(
      everything.filter((tab) => tab.built).map((tab) => tab.id),
    );
    // M1-54 built the queue's Charts and Forecast; every other unbuilt tab is still listed with its reason.
    expect([...built].sort()).toEqual([
      'charts',
      'config',
      'consumers',
      'forecast',
      'overview',
      'routing',
    ]);
    const gates = Object.fromEntries(
      everything
        .filter((tab) => tab.gate !== null)
        .map((tab) => [tab.id, tab.gate]),
    );
    expect(gates).toEqual({
      messages: 'amqp.peek',
      browse: 'streams.browse',
      publish: 'amqp.publish',
      tap: 'amqp.tap',
    });
    // A tab that needs a gate is never one that is built: nothing reaches a message yet.
    expect(everything.filter((tab) => tab.gate !== null && tab.built)).toEqual(
      [],
    );
    // Every id of every set is a known id, and the Overview is first.
    for (const set of [queue, stream, exchange]) {
      expect(set[0]?.id).toBe('overview');
      for (const tab of set) expect(ENTITY_TAB_IDS).toContain(tab.id);
    }

    // The tab an address names: none is the Overview, a tab the entity lacks is null.
    expect(resolveTab(queue, null)?.id).toBe('overview');
    expect(resolveTab(queue, 'routing')?.id).toBe('routing');
    expect(resolveTab(stream, 'messages')).toBeNull();
    expect(resolveTab(stream, 'browse')?.id).toBe('browse');
    expect(resolveTab(queue, 'nope')).toBeNull();
  });
});
