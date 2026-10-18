import { describe, expect, it } from 'vitest';

import {
  ForgedProofError,
  mintConfirmedCopyProof,
  mintDestructiveConsentProof,
  mintSafeReturnProof,
  type Delivery,
} from '@app/ports';

import type { ConnectionEvent } from '../channel.ts';
import { connectSource } from '../connect.ts';
import { Amqp091Error } from '../errors.ts';
import { message } from '../testing/fake-driver.ts';
import { harness } from '../testing/harness.ts';

async function open() {
  const h = harness();
  const opened = await connectSource(h.options);
  const events: ConnectionEvent[] = [];
  opened.subscribe((event) => events.push(event));
  const received: (Delivery | null)[] = [];
  const { consumerTag } = await opened.lease.consume('dlq', 5, (delivery) =>
    received.push(delivery),
  );
  const channel = h.driver.model.last();
  return { ...h, ...opened, events, received, consumerTag, channel };
}

const reasonOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Amqp091Error ? error.reason : error),
  );

describe('SourceLease', () => {
  it('has exactly the source methods: it cannot publish, declare or reject', async () => {
    const { lease } = await open();
    expect(Object.keys(lease).sort()).toEqual([
      'ackWithProof',
      'cancel',
      'consume',
      'nackRequeue',
      'qosBarrier',
      'release',
    ]);
    const loose = lease as unknown as Record<string, unknown>;
    for (const forbidden of ['publish', 'get', 'reject', 'declareTapQueue']) {
      expect(loose[forbidden]).toBeUndefined();
    }
    expect(Object.isFrozen(lease)).toBe(true);
  });

  it('sets the prefetch before it consumes, with manual acknowledgement', async () => {
    const { channel, consumerTag } = await open();
    expect(consumerTag).toBe('ctag-1');
    expect(channel.calls.map((call) => call.method)).toEqual([
      'prefetch',
      'consume',
    ]);
    expect(channel.calls[0]?.args).toEqual([5, false]);
    expect(channel.calls[1]?.args).toEqual(['dlq', { noAck: false }]);
  });

  it('passes deliveries on as typed deliveries and holds their tags', async () => {
    const { channel, received, lease } = await open();
    channel.deliver(message(1, { body: 'a', headers: { n: 1 } }));
    expect(received).toHaveLength(1);
    expect(received[0]?.tag).toBe(1n);
    expect(received[0]?.headers.n).toEqual({ t: 'long', v: 1 });
    lease.ackWithProof(
      1n,
      mintConfirmedCopyProof({ destination: 'parked', confirmedAt: 1 }),
    );
    expect(channel.calls.at(-1)).toEqual({ method: 'ack', args: [1, false] });
  });

  it('refuses an ack with a forged proof, a safe-return proof, or for a tag it does not hold', async () => {
    const { channel, lease } = await open();
    channel.deliver(message(1));
    expect(() => {
      lease.ackWithProof(1n, {
        kind: 'destructive-consent',
        planHash: 'h',
      } as never);
    }).toThrow(ForgedProofError);
    expect(() => {
      lease.ackWithProof(
        1n,
        mintSafeReturnProof({ reason: 'classic' }) as never,
      );
    }).toThrow(ForgedProofError);
    expect(() => {
      lease.ackWithProof(9n, mintDestructiveConsentProof({ planHash: 'h' }));
    }).toThrow(
      expect.objectContaining({ reason: 'unknown-delivery-tag' }) as Error,
    );
    expect(channel.count('ack')).toBe(0);
    expect(channel.closed).toBe(false);
  });

  it('returning a delivery needs a safe-return proof: a literal, a confirmed copy or a consent is refused', async () => {
    const { channel, lease } = await open();
    channel.deliver(message(1));
    for (const forged of [
      undefined,
      { kind: 'safe-return', reason: 'classic' },
      mintConfirmedCopyProof({ destination: 'x', confirmedAt: 1 }),
      mintDestructiveConsentProof({ planHash: 'h' }),
    ]) {
      expect(() => {
        lease.nackRequeue(1n, forged as never);
      }).toThrow(ForgedProofError);
    }
    expect(channel.count('nack')).toBe(0);

    lease.nackRequeue(1n, mintSafeReturnProof({ reason: 'quorum-unlimited' }));
    // One delivery, requeued, never "multiple".
    expect(channel.calls.at(-1)).toEqual({
      method: 'nack',
      args: [1, false, true],
    });
  });

  it('a return followed by the barrier resolves after the qos and then releases cleanly', async () => {
    const { channel, lease } = await open();
    channel.deliver(message(1));
    lease.nackRequeue(1n, mintSafeReturnProof({ reason: 'classic' }));
    await lease.qosBarrier(1);
    await lease.release('healthy');
    expect(channel.calls.map((call) => call.method)).toEqual([
      'prefetch',
      'consume',
      'nack',
      'prefetch',
      'cancel',
      'close',
    ]);
  });

  it('release(healthy) refuses while deliveries are held, and the lease stays usable', async () => {
    const { channel, lease, driver } = await open();
    channel.deliver(message(1));
    expect(await reasonOf(lease.release('healthy'))).toBe('held-deliveries');
    expect(driver.model.closed).toBe(false);
    expect(channel.count('nack')).toBe(0);
    lease.ackWithProof(1n, mintDestructiveConsentProof({ planHash: 'h' }));
    await lease.release('healthy');
    expect(driver.model.closed).toBe(true);
  });

  it('release(poisoned) closes at once and returns nothing on its own', async () => {
    const { channel, lease, driver } = await open();
    channel.deliver(message(1));
    await lease.release('poisoned');
    expect(driver.model.closed).toBe(true);
    expect(channel.count('nack')).toBe(0);
  });

  it('a server cancel is reported as a null delivery and an event; held tags stay held', async () => {
    const { channel, received, events, lease } = await open();
    channel.deliver(message(1));
    channel.cancelFromServer();
    expect(received.at(-1)).toBeNull();
    expect(events).toContainEqual({
      type: 'server-cancel',
      consumerTag: 'ctag-1',
    });
    // Whether the broker accepts this ack after the cancel is evidence for M0-28; the lease
    // does not forget the tag on its own.
    lease.ackWithProof(1n, mintDestructiveConsentProof({ planHash: 'h' }));
    expect(channel.count('ack')).toBe(1);
  });

  it('a callback that throws is reported, and the delivery stays held', async () => {
    const h = harness();
    const opened = await connectSource(h.options);
    const events: ConnectionEvent[] = [];
    opened.subscribe((event) => events.push(event));
    await opened.lease.consume('dlq', 2, () => {
      throw new Error('boom');
    });
    h.driver.model.last().deliver(message(1));
    expect(events).toContainEqual({ type: 'handler-error' });
    expect(() => {
      opened.lease.nackRequeue(1n, mintSafeReturnProof({ reason: 'classic' }));
    }).not.toThrow();
  });

  it('a broker that sends more than the prefetch gets no further work, but what is tracked can still be settled', async () => {
    const { channel, events, lease, received } = await open();
    for (let tag = 1; tag <= 6; tag += 1) channel.deliver(message(tag));
    expect(events.some((event) => event.type === 'channel-error')).toBe(true);
    // The sixth delivery was never recorded or passed on, so it cannot be settled by mistake.
    expect(received).toHaveLength(5);
    expect(() => {
      lease.ackWithProof(6n, mintDestructiveConsentProof({ planHash: 'h' }));
    }).toThrow(
      expect.objectContaining({ reason: 'unknown-delivery-tag' }) as Error,
    );
    lease.ackWithProof(1n, mintDestructiveConsentProof({ planHash: 'h' }));
    expect(channel.count('ack')).toBe(1);
  });

  it('has one consumer, validates the prefetch and cancels only its own consumer', async () => {
    const { lease } = await open();
    expect(await reasonOf(lease.consume('dlq', 1, () => undefined))).toBe(
      'busy',
    );
    expect(await reasonOf(lease.cancel('someone-else'))).toBe('not-own-queue');
    const h = harness();
    const fresh = await connectSource(h.options);
    expect(await reasonOf(fresh.lease.consume('dlq', 0, () => undefined))).toBe(
      'invalid-argument',
    );
    expect(
      await reasonOf(fresh.lease.consume('dlq', 99_999, () => undefined)),
    ).toBe('invalid-argument');
    expect(h.driver.model.channels).toHaveLength(0);
  });
});
