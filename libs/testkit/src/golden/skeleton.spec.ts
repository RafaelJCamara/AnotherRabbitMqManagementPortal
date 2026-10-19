import { describe, expect, it } from 'vitest';

import { diffShapes, jsonShape, prometheusShape } from './skeleton.ts';

describe('jsonShape', () => {
  it('lists every path with its type and merges the types an array holds', () => {
    expect(
      jsonShape({
        items: [
          { name: 'a', policy: null, n: 1 },
          { name: 'b', policy: 'p', n: 2 },
        ],
        ok: true,
      }),
    ).toEqual([
      '$.items: array',
      '$.items[].n: number',
      '$.items[].name: string',
      '$.items[].policy: null|string',
      '$.items[]: object',
      '$.ok: boolean',
      '$: object',
    ]);
  });

  it('does not depend on values, so two recordings of one broker have one shape', () => {
    const first = { uptime: 10, name: 'rabbit@a', queues: [{ messages: 1 }] };
    const second = { uptime: 99, name: 'rabbit@b', queues: [{ messages: 7 }] };
    expect(jsonShape(first)).toEqual(jsonShape(second));
  });

  it('collapses timing-dependent subtrees into one line', () => {
    const quiet = {
      message_stats: {},
      publish_details: { rate: 0 },
      name: 'q',
    };
    const busy = {
      message_stats: { publish: 5, publish_details: { rate: 1.5 } },
      publish_details: { rate: 2 },
      name: 'q',
    };
    expect(jsonShape(quiet)).toEqual(jsonShape(busy));
  });

  it('reports a field that appears or disappears', () => {
    const before = jsonShape({ a: 1, policy: 'p' });
    const after = jsonShape({ a: 1 });
    expect(diffShapes(before, after)).toEqual({
      removed: ['$.policy: string'],
      added: [],
    });
    expect(diffShapes(after, before).added).toEqual(['$.policy: string']);
    expect(diffShapes(before, before)).toEqual({ removed: [], added: [] });
  });
});

describe('prometheusShape', () => {
  const page = [
    '# HELP rabbitmq_queues Queues available',
    '# TYPE rabbitmq_queues gauge',
    'rabbitmq_queues{vhost="/"} 4',
    'rabbitmq_queues{vhost="golden"} 3',
    '# TYPE rabbitmq_identity_info gauge',
    'rabbitmq_identity_info{rabbitmq_node="rabbit@a",rabbitmq_version="4.3.6"} 1',
    'rabbitmq_up 1 1700000000',
  ].join('\n');

  it('keeps families, types and label names, and drops values and label values', () => {
    expect(prometheusShape(page)).toEqual([
      '# TYPE rabbitmq_identity_info gauge',
      '# TYPE rabbitmq_queues gauge',
      'rabbitmq_identity_info{rabbitmq_node,rabbitmq_version}',
      'rabbitmq_queues{vhost}',
      'rabbitmq_up{}',
    ]);
  });

  it('is the same for two scrapes whose values differ', () => {
    const later = page
      .replaceAll('} 4', '} 40')
      .replace('rabbit@a', 'rabbit@b');
    expect(prometheusShape(later)).toEqual(prometheusShape(page));
  });

  it('flags a line that is not exposition format', () => {
    expect(prometheusShape('not a metric line')).toEqual([
      '? not a metric line',
    ]);
  });
});
