// Contract: `get`, `nack(multiple)`, the qos barrier, `ack` and passive declares, through the peek
// lease, once per client library (M0-28, DC-48). Each test reads the behaviour off the broker, so
// the same expectation holds for both libraries or the swap is not safe.
import { describe, expect, it } from 'vitest';

import { mintDestructiveConsentProof, type Delivery } from '@app/ports';

import {
  Amqp091Error,
  connectControl,
  connectPeek,
  connectPublish,
  type ConnectionEvent,
} from '../src/index.ts';
import {
  contractBroker,
  decode,
  declare,
  fill,
  optionsFor,
  subjects,
  unique,
  waitFor,
  type QueueKind,
} from './harness.ts';

const REQUEUE_ALL = { multiple: true, requeue: true } as const;
const broker = contractBroker();
const kinds: readonly QueueKind[] = ['classic', 'quorum'];

describe.each(subjects)('$name', (subject) => {
  const peek = (type: QueueKind | 'classic' = 'classic') =>
    connectPeek({
      ...optionsFor(broker, subject, unique('peek')),
      queueTypes: { typeOf: () => type },
    });

  it.each(kinds)(
    'AC-1 get x3, nackRequeue(last, multiple), then the barrier: the three messages are ready again (%s)',
    async (type) => {
      const queue = unique(`nack-${type}`);
      await declare(broker, queue, type);
      await fill(broker, subject, queue, ['m1', 'm2', 'm3']);

      const { lease } = await peek(type);
      const got: Delivery[] = [];
      for (let i = 0; i < 3; i += 1) {
        const delivery = await lease.get(queue);
        expect(delivery).not.toBeNull();
        if (delivery !== null) got.push(delivery);
      }
      expect(got.map((d) => decode(d.body))).toEqual(['m1', 'm2', 'm3']);
      expect(got.every((d) => !d.redelivered)).toBe(true);
      expect(got.map((d) => d.exchange)).toEqual(['', '', '']);
      expect(got.map((d) => d.routingKey)).toEqual([queue, queue, queue]);
      // Held deliveries are not ready.
      expect(
        (await lease.throwaway((c) => c.checkQueue(queue))).messageCount,
      ).toBe(0);

      lease.nackRequeue(got[2]?.tag ?? 0n, REQUEUE_ALL);
      await lease.qosBarrier(1);

      // A quorum queue applies the return through its log, so its counts follow a moment later.
      await waitFor(
        async () =>
          (await lease.throwaway((c) => c.checkQueue(queue))).messageCount ===
          3,
        10_000,
        'three ready messages',
      );
      const again = await lease.get(queue);
      expect(again).toMatchObject({ redelivered: true });
      expect(decode(again?.body ?? new Uint8Array())).toBe('m1');
      await lease.release('healthy');

      const control = await connectControl(
        optionsFor(broker, subject, unique('ctl')),
      );
      expect((await control.lease.checkQueue(queue)).messageCount).toBe(3);
      await control.lease.release();
    },
  );

  it('AC-1 get on an empty queue answers null and keeps the lease usable', async () => {
    const queue = unique('empty');
    await declare(broker, queue, 'classic');
    const { lease } = await peek();
    expect(await lease.get(queue)).toBeNull();
    await fill(broker, subject, queue, ['late']);
    expect(decode((await lease.get(queue))?.body ?? new Uint8Array())).toBe(
      'late',
    );
    await lease.release('healthy');
  });

  it('AC-1 an ack with a destructive consent removes exactly the acked message; the rest return', async () => {
    const queue = unique('ack');
    await declare(broker, queue, 'classic');
    await fill(broker, subject, queue, ['a', 'b', 'c']);
    const { lease } = await peek();
    await lease.get(queue);
    const second = await lease.get(queue);
    const third = await lease.get(queue);
    lease.ackWithProof(
      third?.tag ?? 0n,
      mintDestructiveConsentProof({ planHash: 'contract' }),
    );
    lease.nackRequeue(second?.tag ?? 0n, REQUEUE_ALL);
    await lease.qosBarrier(1);
    expect(
      (await lease.throwaway((c) => c.checkQueue(queue))).messageCount,
    ).toBe(2);
    await lease.release('healthy');
  });

  it('AC-1 release(healthy) with deliveries held returns them before it closes', async () => {
    const queue = unique('flush');
    await declare(broker, queue, 'classic');
    await fill(broker, subject, queue, ['x', 'y']);
    const opened = await peek();
    const events: ConnectionEvent[] = [];
    opened.subscribe((event) => events.push(event));
    await opened.lease.get(queue);
    await opened.lease.get(queue);
    await opened.lease.release('healthy');
    expect(events).toContainEqual({ type: 'release-flush', count: 2 });

    const control = await connectControl(
      optionsFor(broker, subject, unique('ctl')),
    );
    expect((await control.lease.checkQueue(queue)).messageCount).toBe(2);
    await control.lease.release();
  });

  it('AC-1 a passive declare of a missing queue is NOT_FOUND on its own channel and leaves the lease usable', async () => {
    const { lease } = await peek();
    const error = await lease
      .throwaway((c) => c.checkQueue(unique('missing')))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      reason: 'channel-closed',
    });
    expect((error as Amqp091Error).broker?.code).toBe(404);

    const queue = unique('after');
    await declare(broker, queue, 'classic');
    await fill(broker, subject, queue, ['still works']);
    expect(decode((await lease.get(queue))?.body ?? new Uint8Array())).toBe(
      'still works',
    );
    await lease.release('healthy');
  });

  it('AC-1 properties and typed headers survive a publish and a get', async () => {
    const queue = unique('props');
    await declare(broker, queue, 'classic');
    const pub = await connectPublish(
      optionsFor(broker, subject, unique('pub')),
    );
    await pub.lease.publish(
      '',
      queue,
      new TextEncoder().encode('p'),
      {
        contentType: 'text/plain',
        messageId: 'm-1',
        correlationId: 'c-1',
        appId: 'contract',
        deliveryMode: 2,
        timestamp: 1_700_000_000,
        headers: {
          s: { t: 'string', v: 'text' },
          flag: { t: 'bool', v: true },
          n: { t: 'long', v: 7 },
          big: { t: 'long', v: 2 ** 40 },
          when: { t: 'timestamp', v: 1_700_000_000 },
          list: { t: 'array', v: [{ t: 'string', v: 'a' }] },
          nested: { t: 'table', v: { k: { t: 'bool', v: false } } },
        },
      },
      { mandatory: true, timeoutMs: 10_000 },
    );
    await pub.lease.release();

    const { lease } = await peek();
    const delivery = await lease.get(queue);
    expect(delivery?.properties).toMatchObject({
      contentType: 'text/plain',
      messageId: 'm-1',
      correlationId: 'c-1',
      appId: 'contract',
      deliveryMode: 2,
      timestamp: 1_700_000_000,
    });
    expect(delivery?.headers).toMatchObject({
      s: { t: 'string', v: 'text' },
      flag: { t: 'bool', v: true },
      n: { t: 'long', v: 7 },
      big: { t: 'long', v: 2 ** 40 },
      when: { t: 'timestamp', v: 1_700_000_000 },
      list: { t: 'array', v: [{ t: 'string', v: 'a' }] },
      nested: { t: 'table', v: { k: { t: 'bool', v: false } } },
    });
    await lease.release('healthy');
  });
});
