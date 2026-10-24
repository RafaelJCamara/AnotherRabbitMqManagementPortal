import type { ConnectionId } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import {
  FAKE_CONNECTION_ID,
  createTopologyFakeDeps,
  sampleProfile,
  type FakeVhost,
} from '../testing';

import { collectGaps, contextGaps } from './gaps';
import { createSnapshotReader, type Snapshot } from './snapshot';
import { toRoutingTopology } from './to-routing';

const cid = FAKE_CONNECTION_ID as ConnectionId;
const signal = new AbortController().signal;
const profile = sampleProfile();
const convert = async (
  vhost: FakeVhost,
  p = profile,
): Promise<{
  snapshot: Snapshot;
  result: Awaited<ReturnType<typeof toRoutingTopology>>;
}> => {
  const deps = createTopologyFakeDeps({ vhosts: { '/': vhost } });
  const snapshot = await createSnapshotReader({ mgmt: deps.mgmt }).read(
    cid,
    '/',
    signal,
  );
  return {
    snapshot,
    result: await toRoutingTopology(snapshot, p, {
      yieldNow: () => Promise.resolve(),
      every: 10,
    }),
  };
};

describe('toRoutingTopology', () => {
  it('maps exchanges, queues and bindings to the routing topology', async () => {
    const { result } = await convert({
      exchanges: [
        { name: 'in', type: 'topic' },
        { name: 'hidden', type: 'fanout', internal: true },
      ],
      queues: [
        { name: 'a', type: 'classic', policy: null, operator_policy: null },
      ],
      bindings: [
        { source: 'in', destination: 'a', routing_key: 'a.*' },
        {
          source: 'in',
          destination: 'hidden',
          destination_type: 'exchange',
          routing_key: '#',
          arguments: { 'x-match': 'all' },
        },
      ],
    });

    expect(result.topology.exchanges).toEqual([
      { name: 'in', type: 'topic', alternateExchange: null },
      {
        name: 'hidden',
        type: 'fanout',
        internal: true,
        alternateExchange: null,
      },
    ]);
    expect(result.topology.queues).toEqual([{ name: 'a', type: 'classic' }]);
    expect(result.topology.bindings).toEqual([
      {
        source: 'in',
        destination: 'a',
        destinationType: 'queue',
        routingKey: 'a.*',
      },
      {
        source: 'in',
        destination: 'hidden',
        destinationType: 'exchange',
        routingKey: '#',
        arguments: { 'x-match': 'all' },
      },
    ]);
    expect(result.gaps).toEqual([]);
  });

  it('reads the alternate exchange from the argument or a policy', async () => {
    const { result } = await convert({
      exchanges: [
        { name: 'x', arguments: { 'alternate-exchange': 'ae' } },
        { name: 'y' },
        { name: 'ae', type: 'fanout' },
      ],
      policies: [
        {
          name: 'p',
          pattern: '^y$',
          'apply-to': 'exchanges',
          definition: { 'alternate-exchange': 'ae' },
        },
      ],
    });

    const byName = Object.fromEntries(
      result.topology.exchanges.map((e) => [e.name, e.alternateExchange]),
    );
    expect(byName).toEqual({ x: 'ae', y: 'ae', ae: null });
  });

  it('raises the gaps its rows cause and passes the four context gaps on', async () => {
    const { result } = await convert(
      {
        queues: [{ name: 'a', type: 'quorum' }],
        policies: 'forbidden',
        operatorPolicies: 'method-not-allowed',
      },
      sampleProfile({
        identity: {
          user: 'app',
          tags: ['management'],
          isAdmin: false,
          canMonitor: false,
          isPolicymaker: false,
        },
      }),
    );

    expect(result.gaps).toEqual([
      'policy-unreadable',
      'operator-policy-unreadable',
      'stats-fields-missing',
      'other-clients-may-declare',
    ]);
    expect(contextGaps([...result.gaps, 'truncated'])).toEqual(result.gaps);
  });

  it('counts a binding of an unknown destination type as a cut, not silently', async () => {
    const { result } = await convert({
      queues: [{ name: 'a', policy: null, operator_policy: null }],
      bindings: [
        { source: 'x', destination: 'a' },
        // A destination type the simulator has no meaning for.
        { source: 'x', destination: 'a', destination_type: 'stream' as never },
      ],
    });

    expect(result.topology.bindings).toHaveLength(1);
    expect(result.gaps).toContain('truncated');
  });
});

describe('collectGaps', () => {
  it('is sorted in the order of the codes and raises policy-match-undecided only when told', async () => {
    const { snapshot } = await convert({});
    expect(
      collectGaps(snapshot, profile, {
        statsMissing: true,
        undecided: true,
        skipped: 0,
      }),
    ).toEqual(['stats-fields-missing', 'policy-match-undecided']);
    expect(
      collectGaps(snapshot, profile, {
        statsMissing: false,
        undecided: false,
        skipped: 0,
      }),
    ).toEqual([]);
  });

  it('trusts an administrator or a monitoring user to see every queue, and nobody else', async () => {
    const { snapshot } = await convert({});
    const who = (isAdmin: boolean, canMonitor: boolean) =>
      collectGaps(
        snapshot,
        sampleProfile({
          identity: {
            user: 'u',
            tags: [],
            isAdmin,
            canMonitor,
            isPolicymaker: false,
          },
        }),
        { statsMissing: false, undecided: false, skipped: 0 },
      );
    expect(who(true, false)).toEqual([]);
    expect(who(false, true)).toEqual([]);
    expect(who(false, false)).toEqual(['other-clients-may-declare']);
  });
});
