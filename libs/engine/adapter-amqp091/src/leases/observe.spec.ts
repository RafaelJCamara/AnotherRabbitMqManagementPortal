import { describe, expect, it } from 'vitest';

import type { Delivery, TapQueueSpec } from '@app/ports';

import { connectObserve } from '../connect.ts';
import { Amqp091Error } from '../errors.ts';
import { message } from '../testing/fake-driver.ts';
import { harness } from '../testing/harness.ts';

const tap = (name = 'product.tap.s1'): TapQueueSpec => ({
  name: name as TapQueueSpec['name'],
  exclusive: true,
  autoDelete: true,
  durable: false,
  args: {
    'x-queue-type': 'classic',
    'x-max-length': 1000,
    'x-overflow': 'drop-head',
    'x-message-ttl': 60_000,
    'x-expires': 120_000,
    'x-product-session': 's1',
  },
});

async function open() {
  const h = harness();
  const opened = await connectObserve(h.options);
  return { ...h, ...opened };
}

const reasonOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Amqp091Error ? error.reason : error),
  );

describe('ObserveLease', () => {
  it('has exactly the observe methods: it cannot publish, get, or settle a user message', async () => {
    const { lease } = await open();
    expect(Object.keys(lease).sort()).toEqual([
      'ackTap',
      'bindQueue',
      'consume',
      'declareTapQueue',
      'release',
      'unbindQueue',
    ]);
    const loose = lease as unknown as Record<string, unknown>;
    for (const forbidden of [
      'publish',
      'get',
      'ackWithProof',
      'nackRequeue',
      'reject',
    ]) {
      expect(loose[forbidden]).toBeUndefined();
    }
    expect(Object.isFrozen(lease)).toBe(true);
  });

  it('declares a tap queue exclusive, auto-delete, not durable, with its bounded arguments', async () => {
    const { lease, driver } = await open();
    await lease.declareTapQueue(tap());
    expect(driver.model.last().calls[0]).toEqual({
      method: 'assertQueue',
      args: [
        'product.tap.s1',
        {
          exclusive: true,
          durable: false,
          autoDelete: true,
          arguments: {
            'x-queue-type': 'classic',
            'x-overflow': 'drop-head',
            'x-max-length': 1000,
            'x-message-ttl': 60_000,
            'x-expires': 120_000,
            'x-product-session': 's1',
          },
        },
      ],
    });
  });

  it.each([
    [
      'a durable queue',
      (spec: Record<string, unknown>) => ({ ...spec, durable: true }),
    ],
    [
      'a non-exclusive queue',
      (spec: Record<string, unknown>) => ({ ...spec, exclusive: false }),
    ],
    [
      'a name that is not a tap',
      (spec: Record<string, unknown>) => ({ ...spec, name: 'orders' }),
    ],
    [
      'an unbounded queue (no x-max-length)',
      (spec: Record<string, unknown>) => {
        const args = { ...(spec.args as Record<string, unknown>) };
        delete args['x-max-length'];
        return { ...spec, args };
      },
    ],
    [
      'a reject-publish overflow',
      (spec: Record<string, unknown>) => ({
        ...spec,
        args: { ...(spec.args as object), 'x-overflow': 'reject-publish' },
      }),
    ],
    [
      'an argument that is not a session marker',
      (spec: Record<string, unknown>) => ({
        ...spec,
        args: { ...(spec.args as object), 'x-dead-letter-exchange': 'x' },
      }),
    ],
  ])('refuses %s and sends nothing', async (_name, mutate) => {
    const { lease, driver } = await open();
    const bad = mutate(tap() as unknown as Record<string, unknown>);
    expect(await reasonOf(lease.declareTapQueue(bad as never))).toBe(
      'invalid-argument',
    );
    expect(driver.model.channels).toHaveLength(0);
  });

  it('binds, unbinds and consumes only the tap queues it declared', async () => {
    const { lease, driver } = await open();
    expect(
      await reasonOf(lease.bindQueue('orders', 'amq.topic', '#', {})),
    ).toBe('not-own-queue');
    expect(
      await reasonOf(lease.unbindQueue('orders', 'amq.topic', '#', {})),
    ).toBe('not-own-queue');
    expect(await reasonOf(lease.consume('orders', 10, () => undefined))).toBe(
      'not-own-queue',
    );
    expect(driver.model.channels).toHaveLength(0);

    await lease.declareTapQueue(tap());
    await lease.bindQueue('product.tap.s1', 'amq.topic', 'orders.#', {});
    await lease.unbindQueue('product.tap.s1', 'amq.topic', 'orders.#', {});
    const methods = driver.model.channels
      .flatMap((channel) => channel.calls)
      .map((call) => call.method);
    expect(methods).toEqual(['assertQueue', 'bindQueue', 'unbindQueue']);
  });

  it('consumes a tap queue with the prefetch first and acks only copies it holds', async () => {
    const { lease, driver } = await open();
    await lease.declareTapQueue(tap());
    const seen: (Delivery | null)[] = [];
    await lease.consume('product.tap.s1', 3, (delivery) => seen.push(delivery));
    const consumer = driver.model.last();
    expect(consumer.calls.map((call) => call.method)).toEqual([
      'prefetch',
      'consume',
    ]);
    consumer.deliver(message(1));
    consumer.deliver(message(2));
    expect(seen.map((delivery) => delivery?.tag)).toEqual([1n, 2n]);

    expect(() => {
      lease.ackTap(7n, false);
    }).toThrow(
      expect.objectContaining({ reason: 'unknown-delivery-tag' }) as Error,
    );
    lease.ackTap(2n, true);
    expect(consumer.calls.at(-1)).toEqual({ method: 'ack', args: [2, true] });
    expect(() => {
      lease.ackTap(1n, false);
    }).toThrow(
      expect.objectContaining({ reason: 'unknown-delivery-tag' }) as Error,
    );
    expect(consumer.closed).toBe(false);
  });

  it('ackTap before anything was consumed is refused', async () => {
    const { lease } = await open();
    expect(() => {
      lease.ackTap(1n, false);
    }).toThrow(
      expect.objectContaining({ reason: 'unknown-delivery-tag' }) as Error,
    );
  });

  it('declares at most 32 tap queues', async () => {
    const { lease } = await open();
    for (let index = 0; index < 32; index += 1) {
      await lease.declareTapQueue(tap(`product.tap.s${String(index)}`));
    }
    expect(
      await reasonOf(lease.declareTapQueue(tap('product.tap.extra'))),
    ).toBe('invalid-argument');
  });

  it('release cancels the consumer and closes everything', async () => {
    const { lease, driver } = await open();
    await lease.declareTapQueue(tap());
    await lease.consume('product.tap.s1', 3, () => undefined);
    await lease.release();
    expect(driver.model.closed).toBe(true);
    expect(driver.model.channels.every((channel) => channel.closed)).toBe(true);
    expect(await reasonOf(lease.declareTapQueue(tap()))).toBe('released');
  });
});
