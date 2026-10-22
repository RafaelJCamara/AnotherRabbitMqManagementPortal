import { describe, expect, it } from 'vitest';

import type { ConnectionId } from '@app/contracts';
import type { PromSample } from '@app/ports';

import { DEFAULT_METRICS_LIMITS } from '../deps';

import { beginRound } from './ingest';
import { createHotStore, queueKeyOf, type SeriesParts } from './store-hot';

const CID = 'c1' as ConnectionId;
const META = { source: 'prometheus', approximate: false } as const;
const sample = (
  name: string,
  value: number,
  labels: Record<string, string> = {},
): PromSample => ({ name, labels, value });

const store = () =>
  createHotStore({ ringPoints: 100, maxQueueSeries: 100, maxBrokers: 4 });
const value = (s: ReturnType<typeof store>, parts: SeriesParts) =>
  s.read(CID, parts)?.points.at(-1)?.v;

describe('ingest', () => {
  it('AC-14 a cluster series is stored once per round, from the lowest node; node series keep their node', () => {
    const s = store();
    const round = beginRound(DEFAULT_METRICS_LIMITS, new Set());
    round.add('rabbit@n2', sample('rabbitmq_queue_messages_ready', 20));
    round.add('rabbit@n1', sample('rabbitmq_queue_messages_ready', 10));
    round.add(
      'rabbit@n1',
      sample('rabbitmq_process_resident_memory_bytes', 111),
    );
    round.add(
      'rabbit@n2',
      sample('rabbitmq_process_resident_memory_bytes', 222),
    );
    // Not in the catalogue: ignored without a trace.
    round.add('rabbit@n1', sample('erlang_vm_dist_recv_bytes', 5));
    const summary = round.commit(s, CID, 1_000, META);
    expect(summary).toEqual({ stored: 3, refused: 0, droppedSamples: 0 });
    expect(value(s, { metric: 'messages_ready' })).toBe(10);
    expect(value(s, { metric: 'memory_bytes', node: 'rabbit@n1' })).toBe(111);
    expect(value(s, { metric: 'memory_bytes', node: 'rabbit@n2' })).toBe(222);
    expect(s.read(CID, { metric: 'messages_ready' })?.points).toEqual([
      { t: 1_000, v: 10 },
    ]);
  });

  it('AC-14 both products map to the same series', () => {
    const s = store();
    const round = beginRound(DEFAULT_METRICS_LIMITS, new Set());
    round.add('n', sample('lavinmq_queue_messages_ready', 4));
    round.add('n', sample('lavinmq_global_messages_acknowledged_total', 77));
    round.add('n', sample('rabbitmq_channel_messages_acked_total', 88));
    round.commit(s, CID, 5, META);
    // Both names are the same series: one point per round, the lowest node's candidate (equal here).
    expect(value(s, { metric: 'messages_ready' })).toBe(4);
    expect(s.read(CID, { metric: 'acked_total' })?.points).toHaveLength(1);
  });

  it("AC-14 a queue series is the leader's value, else the lowest node's; other queues are ignored", () => {
    const s = store();
    const wanted = new Set([
      queueKeyOf('/', 'orders'),
      queueKeyOf('/', 'solo'),
    ]);
    const round = beginRound(DEFAULT_METRICS_LIMITS, wanted);
    const q = (queue: string) => ({ vhost: '/', queue });
    round.add(
      'rabbit@n1',
      sample('rabbitmq_detailed_queue_messages_ready', 1, q('orders')),
    );
    round.add(
      'rabbit@n2',
      sample('rabbitmq_detailed_queue_messages_ready', 2, q('orders')),
    );
    round.add(
      'rabbit@n3',
      sample('rabbitmq_detailed_queue_messages_ready', 3, q('orders')),
    );
    round.add(
      'rabbit@n2',
      sample('rabbitmq_detailed_queue_info', 1, {
        ...q('orders'),
        membership: 'leader',
      }),
    );
    round.add(
      'rabbit@n3',
      sample('rabbitmq_detailed_queue_info', 1, {
        ...q('orders'),
        membership: 'follower',
      }),
    );
    round.add(
      'rabbit@n3',
      sample('rabbitmq_detailed_queue_messages_ready', 9, q('solo')),
    );
    round.add(
      'rabbit@n1',
      sample('rabbitmq_detailed_queue_messages_ready', 9, q('solo')),
    );
    round.add(
      'rabbit@n1',
      sample('rabbitmq_detailed_queue_messages_ready', 7, q('stranger')),
    );
    // No vhost label: not a queue sample.
    round.add(
      'rabbit@n1',
      sample('rabbitmq_detailed_queue_messages_ready', 7, { queue: 'x' }),
    );
    const summary = round.commit(s, CID, 10, META);
    expect(summary).toMatchObject({ stored: 2, droppedSamples: 1 });
    const orders = {
      metric: 'queue_messages_ready',
      vhost: '/',
      queue: 'orders',
    } as const;
    expect(value(s, orders)).toBe(2);
    expect(value(s, { ...orders, queue: 'solo' })).toBe(9);
    expect(s.read(CID, { ...orders, queue: 'stranger' })).toBeUndefined();
    // Queue series carry no node label.
    expect(s.read(CID, orders)?.info.parts.node).toBeUndefined();
  });

  it('AC-14 values that are not finite are counted and never stored', () => {
    const s = store();
    const round = beginRound(DEFAULT_METRICS_LIMITS, new Set());
    round.add('n', sample('rabbitmq_connections', Number.NaN));
    round.add('n', sample('rabbitmq_channels', Number.POSITIVE_INFINITY));
    round.add('n', sample('rabbitmq_consumers', 3));
    expect(round.commit(s, CID, 1, META)).toEqual({
      stored: 1,
      refused: 0,
      droppedSamples: 2,
    });
    expect(s.read(CID, { metric: 'connections' })).toBeUndefined();
  });

  it('AC-14 a round holds at most maxRoundCandidates candidates and counts the rest', () => {
    const s = store();
    const round = beginRound({ maxRoundCandidates: 3 }, new Set());
    for (const name of [
      'rabbitmq_connections',
      'rabbitmq_channels',
      'rabbitmq_consumers',
      'rabbitmq_queues',
      'rabbitmq_queue_messages',
    ]) {
      round.add('n', sample(name, 1));
    }
    expect(round.commit(s, CID, 1, META)).toEqual({
      stored: 3,
      refused: 0,
      droppedSamples: 2,
    });
  });

  it('AC-14 a round commits once and is then empty', () => {
    const s = store();
    const round = beginRound(DEFAULT_METRICS_LIMITS, new Set());
    round.add('n', sample('rabbitmq_connections', 1));
    expect(round.commit(s, CID, 1, META).stored).toBe(1);
    expect(round.commit(s, CID, 2, META).stored).toBe(0);
    expect(s.read(CID, { metric: 'connections' })?.points).toHaveLength(1);
  });
});
