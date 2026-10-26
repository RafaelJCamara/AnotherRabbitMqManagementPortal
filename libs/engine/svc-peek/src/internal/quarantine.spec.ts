import type { ConnectionId } from '@app/contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createRecordingSend,
  foundFromSpec,
  throwingSend,
} from './preflight-fakes.ts';
import {
  buildQuarantineSpec,
  conformsToSpec,
  ensureQuarantine,
  type ClassicQuarantineSpec,
  type FoundQueue,
  type QuarantineQueueSpec,
  type QuorumQuarantineSpec,
  quarantineName,
} from './quarantine.ts';

const CID = 'conn-1' as ConnectionId;
const NAME = 'product.quarantine';
const signal = new AbortController().signal;

const classic = (vhost = '/') => buildQuarantineSpec(NAME, vhost, 'classic');
const quorum = (vhost = '/') => buildQuarantineSpec(NAME, vhost, 'quorum');

describe('quarantine spec (rescue preflight)', () => {
  it('M1-13 AC-22 the quarantine spec is literal: reject-publish, no max-length, never drop-head', () => {
    expectTypeOf<
      ClassicQuarantineSpec['arguments']['x-overflow']
    >().toEqualTypeOf<'reject-publish'>();
    expectTypeOf<
      QuorumQuarantineSpec['arguments']['x-overflow']
    >().toEqualTypeOf<'reject-publish'>();
    expectTypeOf<ClassicQuarantineSpec['durable']>().toEqualTypeOf<true>();
    expectTypeOf<ClassicQuarantineSpec['autoDelete']>().toEqualTypeOf<false>();
    expectTypeOf<
      QuorumQuarantineSpec['arguments']['x-delivery-limit']
    >().toEqualTypeOf<-1>();

    expectTypeOf(classic()).toEqualTypeOf<ClassicQuarantineSpec>();
    expectTypeOf(quorum()).toEqualTypeOf<QuorumQuarantineSpec>();

    const dropHead: ClassicQuarantineSpec = {
      ...classic(),
      arguments: {
        'x-queue-type': 'classic',
        // @ts-expect-error drop-head is not a quarantine overflow
        'x-overflow': 'drop-head',
      },
    };
    const withMaxLength: ClassicQuarantineSpec = {
      ...classic(),
      arguments: {
        'x-queue-type': 'classic',
        'x-overflow': 'reject-publish',
        // @ts-expect-error no max-length key can be set
        'x-max-length': 10,
      },
    };
    const nonDurable: ClassicQuarantineSpec = {
      ...classic(),
      // @ts-expect-error the quarantine is durable
      durable: false,
    };
    const finiteLimit: QuorumQuarantineSpec = {
      ...quorum(),
      arguments: {
        'x-queue-type': 'quorum',
        'x-overflow': 'reject-publish',
        // @ts-expect-error the fallback never counts deliveries
        'x-delivery-limit': 20,
      },
    };
    expect([dropHead, withMaxLength, nonDurable, finiteLimit]).toHaveLength(4);

    for (const spec of [classic('/'), quorum('v1')]) {
      expect(spec.arguments['x-overflow']).toBe('reject-publish');
      expect(Object.keys(spec.arguments)).not.toContain('x-max-length');
      expect(Object.keys(spec.arguments)).not.toContain('x-max-length-bytes');
      expect(spec.durable).toBe(true);
      expect(spec.autoDelete).toBe(false);
      expect(spec.name).toBe(NAME);
      expect(Object.isFrozen(spec)).toBe(true);
      expect(Object.isFrozen(spec.arguments)).toBe(true);
    }
    expect(classic().arguments).toEqual({
      'x-queue-type': 'classic',
      'x-overflow': 'reject-publish',
    });
    expect(quorum().arguments).toEqual({
      'x-queue-type': 'quorum',
      'x-overflow': 'reject-publish',
      'x-delivery-limit': -1,
    });
    expect(classic('v1').vhost).toBe('v1');
  });

  it('M1-13 AC-23 the quarantine name comes from an injected prefix and a bad prefix fails at construction', () => {
    for (const prefix of ['product', 'acme-tools', 'a', 'x9-y']) {
      expect(quarantineName(prefix)).toBe(`${prefix}.quarantine`);
    }
    const longest = 'a'.repeat(40);
    expect(quarantineName(longest)).toBe(`${longest}.quarantine`);
    expect(
      new TextEncoder().encode(quarantineName(longest)).length,
    ).toBeLessThanOrEqual(255);

    const bad = [
      '',
      'RabbitTool',
      'rmq-x',
      'amq',
      'amqp-tools',
      'Has Space',
      'a'.repeat(41),
      'my-rmq',
      'xrabbitmqx',
      '9lives',
      '-dash',
      'dot.ted',
      'under_score',
    ];
    for (const prefix of bad) {
      expect(() => quarantineName(prefix), JSON.stringify(prefix)).toThrow(
        RangeError,
      );
    }
    // The text of the error names the rule, not the offending value (the prefix may be a setting).
    expect(() => quarantineName('rmq-x')).toThrow(/rabbitmq|rmq/);
  });

  it('M1-13 AC-24 ensureQuarantine sends one PUT only when the queue is absent and reuses a conforming queue', async () => {
    // Absent: exactly one PUT, vhost and name URL-encoded, the spec body, nothing else.
    for (const [vhost, name, encoded] of [
      ['/', NAME, '%2F/product.quarantine'],
      ['a/b c', 'odd name/x', 'a%2Fb%20c/odd%20name%2Fx'],
    ] as const) {
      const spec = buildQuarantineSpec(name, vhost, 'classic');
      const recorder = createRecordingSend();
      let rereads = 0;
      const outcome = await ensureQuarantine(
        {
          connectionId: CID,
          spec,
          found: null,
          send: recorder.send,
          reread: () => {
            rereads += 1;
            return Promise.resolve(null);
          },
        },
        signal,
      );
      expect(outcome).toEqual({ state: 'created' });
      expect(rereads).toBe(0);
      expect(recorder.calls).toEqual([
        {
          method: 'PUT',
          path: `/api/queues/${encoded}`,
          body: {
            durable: true,
            auto_delete: false,
            arguments: {
              'x-queue-type': 'classic',
              'x-overflow': 'reject-publish',
            },
          },
        },
      ]);
    }
    // The quorum fallback declares its own arguments.
    const quorumRecorder = createRecordingSend();
    await ensureQuarantine(
      {
        connectionId: CID,
        spec: quorum(),
        found: null,
        send: quorumRecorder.send,
        reread: () => Promise.resolve(null),
      },
      signal,
    );
    expect(quorumRecorder.calls).toHaveLength(1);
    expect(quorumRecorder.calls[0]?.body).toEqual({
      durable: true,
      auto_delete: false,
      arguments: {
        'x-queue-type': 'quorum',
        'x-overflow': 'reject-publish',
        'x-delivery-limit': -1,
      },
    });

    // Conforming: no send at all, whatever the type.
    for (const spec of [classic(), quorum()]) {
      expect(
        await ensureQuarantine(
          {
            connectionId: CID,
            spec,
            found: foundFromSpec(spec),
            send: throwingSend,
            reread: () => Promise.reject(new Error('no re-read')),
          },
          signal,
        ),
      ).toEqual({ state: 'reused' });
    }

    // Wrong shape: no send, the queue is never changed.
    const wrong = foundFromSpec(classic(), { durable: false });
    expect(
      await ensureQuarantine(
        {
          connectionId: CID,
          spec: classic(),
          found: wrong,
          send: throwingSend,
          reread: () => Promise.reject(new Error('no re-read')),
        },
        signal,
      ),
    ).toEqual({ state: 'unavailable', reason: 'wrong-shape' });

    // A race: the declare is rejected because the queue appeared; one re-read decides.
    const raced = async (
      now: () => Promise<FoundQueue | null>,
    ): Promise<{ outcome: unknown; sends: number; rereads: number }> => {
      const recorder = createRecordingSend(() =>
        Promise.reject(new Error('conflict')),
      );
      let rereads = 0;
      const outcome = await ensureQuarantine(
        {
          connectionId: CID,
          spec: classic(),
          found: null,
          send: recorder.send,
          reread: () => {
            rereads += 1;
            return now();
          },
        },
        signal,
      );
      expect(recorder.calls.every((call) => call.method === 'PUT')).toBe(true);
      return { outcome, sends: recorder.calls.length, rereads };
    };
    expect(
      await raced(() => Promise.resolve(foundFromSpec(classic()))),
    ).toEqual({
      outcome: { state: 'reused' },
      sends: 1,
      rereads: 1,
    });
    expect(
      await raced(() =>
        Promise.resolve(
          foundFromSpec(classic(), {
            arguments: { 'x-queue-type': 'classic', 'x-overflow': 'drop-head' },
          }),
        ),
      ),
    ).toEqual({
      outcome: { state: 'unavailable', reason: 'wrong-shape' },
      sends: 1,
      rereads: 1,
    });
    // Any other rejection leaves the queue absent: refused. A re-read that fails is unreadable.
    expect(await raced(() => Promise.resolve(null))).toEqual({
      outcome: { state: 'unavailable', reason: 'refused' },
      sends: 1,
      rereads: 1,
    });
    expect(await raced(() => Promise.reject(new Error('read failed')))).toEqual(
      {
        outcome: { state: 'unavailable', reason: 'unreadable' },
        sends: 1,
        rereads: 1,
      },
    );

    // An aborted run is not a refusal: the abort is rethrown, and an aborted run sends nothing.
    const controller = new AbortController();
    const aborting = createRecordingSend(() => {
      controller.abort(new Error('stop'));
      return Promise.reject(new Error('aborted'));
    });
    await expect(
      ensureQuarantine(
        {
          connectionId: CID,
          spec: classic(),
          found: null,
          send: aborting.send,
          reread: () => Promise.resolve(null),
        },
        controller.signal,
      ),
    ).rejects.toThrow('aborted');
    // An abort during the re-read is rethrown too, not reported as an unreadable queue.
    const midway = new AbortController();
    const failing = createRecordingSend(() =>
      Promise.reject(new Error('conflict')),
    );
    await expect(
      ensureQuarantine(
        {
          connectionId: CID,
          spec: classic(),
          found: null,
          send: failing.send,
          reread: () => {
            midway.abort(new Error('stop reading'));
            return Promise.reject(new Error('read failed'));
          },
        },
        midway.signal,
      ),
    ).rejects.toThrow('read failed');
    const before = createRecordingSend();
    await expect(
      ensureQuarantine(
        {
          connectionId: CID,
          spec: classic(),
          found: null,
          send: before.send,
          reread: () => Promise.resolve(null),
        },
        controller.signal,
      ),
    ).rejects.toThrow('stop');
    expect(before.calls).toHaveLength(0);
  });

  it('conformsToSpec is exact: any deviation from the spec is a wrong shape', () => {
    const spec: QuarantineQueueSpec = classic();
    const base = foundFromSpec(spec);
    expect(conformsToSpec(base, spec)).toBe('conforms');
    // A classic queue declared without the type argument is still classic (the `type` field decides).
    expect(
      conformsToSpec(
        foundFromSpec(spec, { arguments: { 'x-overflow': 'reject-publish' } }),
        spec,
      ),
    ).toBe('conforms');
    const deviations: Partial<FoundQueue>[] = [
      { durable: false },
      { autoDelete: true },
      { exclusive: true },
      { type: 'stream' },
      { type: 'quorum' },
      { name: 'other.quarantine' },
      { vhost: 'elsewhere' },
      { arguments: { 'x-queue-type': 'classic' } },
      { arguments: { 'x-queue-type': 'classic', 'x-overflow': 'drop-head' } },
      {
        arguments: {
          'x-queue-type': 'classic',
          'x-overflow': 'reject-publish-dlx',
        },
      },
      { arguments: { ...spec.arguments, 'x-max-length': 10 } },
      { arguments: { ...spec.arguments, 'x-max-length-bytes': 10 } },
      { arguments: { ...spec.arguments, 'x-message-ttl': 1000 } },
      { arguments: { ...spec.arguments, 'x-expires': 1000 } },
      { arguments: { ...spec.arguments, 'x-dead-letter-exchange': 'dlx' } },
      {
        arguments: { 'x-queue-type': 'quorum', 'x-overflow': 'reject-publish' },
      },
    ];
    for (const deviation of deviations) {
      expect(
        conformsToSpec({ ...base, ...deviation }, spec),
        JSON.stringify(deviation),
      ).toBe('wrong-shape');
    }
    const fallback = quorum();
    expect(conformsToSpec(foundFromSpec(fallback), fallback)).toBe('conforms');
    for (const limit of [20, 0, undefined]) {
      const args: Record<string, unknown> = { ...fallback.arguments };
      if (limit === undefined) delete args['x-delivery-limit'];
      else args['x-delivery-limit'] = limit;
      expect(
        conformsToSpec(foundFromSpec(fallback, { arguments: args }), fallback),
      ).toBe('wrong-shape');
    }
    expect(
      conformsToSpec(foundFromSpec(fallback, { type: 'classic' }), fallback),
    ).toBe('wrong-shape');
  });
});
