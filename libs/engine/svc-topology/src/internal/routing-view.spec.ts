import { LOOP_QUEUES_MAX } from '@app/contracts';
import {
  simulate,
  type DlxLoop,
  type DlxSource,
  type RoutingTopology,
} from '@app/routing';
import { describe, expect, it } from 'vitest';

import {
  capList,
  loopView,
  simulationView,
  sourceView,
  unknownReasonView,
} from './routing-view';

describe('M1-20 AC-9 a list longer than its contract is cut and the rest is counted', () => {
  it('cuts a list at its maximum and counts what is left', () => {
    expect(capList([1, 2, 3], 2)).toEqual({ items: [1, 2], more: 1 });
    expect(capList([1, 2], 2)).toEqual({ items: [1, 2], more: 0 });
    expect(capList([])).toEqual({ items: [], more: 0 });
  });

  it('cuts the queues of a long dead-letter loop', () => {
    const queues = Array.from({ length: 250 }, (_, i) => `q${String(i)}`);
    const loop: DlxLoop = { queues, kind: 'drop-loop', possible: true };

    const view = loopView(loop);

    expect(view.queues).toHaveLength(LOOP_QUEUES_MAX);
    expect(view.queuesMore).toBe(250 - LOOP_QUEUES_MAX);
    expect(view).toMatchObject({ kind: 'drop-loop', possible: true });
  });

  it('keeps the limit of a source as the library gave it, a finite one with its value', () => {
    const source = (limit: DlxSource['limit']): DlxSource => ({
      queue: 's',
      limit,
      certainty: 'possible',
      via: ['x'],
      reasons: ['expired'],
    });

    expect(sourceView(source({ kind: 'finite', value: 20 })).limit).toEqual({
      kind: 'finite',
      value: 20,
    });
    expect(sourceView(source({ kind: 'unlimited' })).limit).toEqual({
      kind: 'unlimited',
    });
    expect(sourceView(source({ kind: 'unknown' })).limit).toEqual({
      kind: 'unknown',
    });
  });

  it('leaves the subject of a reason out when there is none', () => {
    expect(unknownReasonView({ code: 'policy-unreadable' })).toEqual({
      code: 'policy-unreadable',
    });
    expect(
      unknownReasonView({ code: 'dead-letter-unknown', subject: 'q' }),
    ).toEqual({ code: 'dead-letter-unknown', subject: 'q' });
  });
});

describe('M1-20 AC-4 the simulation is mapped rule by rule', () => {
  const topology: RoutingTopology = {
    exchanges: [
      { name: 'd', type: 'direct' },
      { name: 't', type: 'topic' },
      { name: 'f', type: 'fanout' },
      { name: 'h', type: 'headers' },
    ],
    queues: [{ name: 'q' }],
    bindings: ['d', 't', 'f', 'h'].map((source) => ({
      source,
      destination: 'q',
      destinationType: 'queue' as const,
      routingKey: source === 't' ? 'a.*' : 'a.b',
      ...(source === 'h' ? { arguments: { colour: 'red' } } : {}),
    })),
  };

  it('keeps the rule that matched for each kind of exchange', () => {
    const rule = (exchange: string, headers = {}) =>
      simulationView(
        simulate(topology, { exchange, routingKey: 'a.b', headers }),
        true,
      ).paths[0]?.hops[0]?.rule;

    expect(rule('d')).toEqual({
      kind: 'direct',
      routingKey: 'a.b',
      keySource: 'routing-key',
    });
    expect(rule('t')).toEqual({
      kind: 'topic',
      pattern: 'a.*',
      routingKey: 'a.b',
      keySource: 'routing-key',
    });
    expect(rule('f')).toEqual({ kind: 'fanout' });
    expect(rule('h', { colour: 'red' })).toMatchObject({
      kind: 'headers',
      mode: 'all',
      arguments: ['colour'],
    });
  });

  it('is not exact and not unroutable when something the answer rests on is missing', () => {
    const result = simulate(topology, { exchange: 'd', routingKey: 'zzz' });

    expect(simulationView(result, true)).toMatchObject({
      unroutable: true,
      exact: true,
    });
    expect(simulationView(result, false)).toMatchObject({
      outcome: 'unroutable',
      unroutable: false,
      exact: false,
    });
  });
});
