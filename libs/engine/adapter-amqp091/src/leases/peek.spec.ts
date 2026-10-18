import { describe, expect, it } from 'vitest';

import {
  ForgedProofError,
  mintConfirmedCopyProof,
  mintDestructiveConsentProof,
  mintSafeReturnProof,
  mintStreamCreditProof,
  type PeekLease,
} from '@app/ports';

import { connectPeek, type ConnectionListener } from '../connect.ts';
import type { ConnectionEvent } from '../channel.ts';
import { Amqp091Error } from '../errors.ts';
import { message } from '../testing/fake-driver.ts';
import { classicQueues, harness, queueTypes } from '../testing/harness.ts';

const REQUEUE_ALL = { multiple: true, requeue: true } as const;

async function open(
  scripted: ReturnType<typeof message>[] = [],
  overrides: Parameters<typeof harness>[0] = {},
) {
  const h = harness(overrides);
  const opened = await connectPeek({
    ...h.options,
    queueTypes: classicQueues,
  });
  // The holding channel exists after the first get; script it as soon as it is opened.
  h.driver.model.onChannel = (channel) => {
    if (!channel.confirm && channel.scriptedGets.length === 0) {
      channel.scriptedGets = [...scripted];
    }
  };
  return { ...h, ...opened };
}

const reasonOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Amqp091Error ? error.reason : error),
  );

describe('PeekLease get / nack / barrier', () => {
  it('AC-2 get x3, then nackRequeue(last, multiple), then the barrier resolves only after qos-ok', async () => {
    const { lease, driver } = await open([message(1), message(2), message(3)]);

    const first = await lease.get('q');
    const second = await lease.get('q');
    const third = await lease.get('q');
    expect([first?.tag, second?.tag, third?.tag]).toEqual([1n, 2n, 3n]);

    const channel = driver.model.last();
    // The broker has not answered the qos yet.
    let release!: () => void;
    channel.prefetchGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    lease.nackRequeue(3n, REQUEUE_ALL);
    let barrierDone = false;
    const barrier = lease.qosBarrier(1).then(() => {
      barrierDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(barrierDone).toBe(false);

    release();
    await barrier;
    expect(barrierDone).toBe(true);
    // One multiple nack with requeue, then the qos on the same channel, in that order.
    expect(channel.calls.map((call) => call.method)).toEqual([
      'get',
      'get',
      'get',
      'nack',
      'prefetch',
    ]);
    expect(channel.calls[3]?.args).toEqual([3, true, true]);
    expect(channel.calls[4]?.args).toEqual([1, false]);
    expect(channel.unacked.size).toBe(0);
  });

  it('AC-2 a cached stream type makes get throw before anything is sent', async () => {
    const h = harness();
    const { lease } = await connectPeek({
      ...h.options,
      queueTypes: queueTypes({ s: 'stream', q: 'classic' }),
    });
    const reason = await reasonOf(lease.get('s'));
    expect(reason).toBe('stream-get-refused');
    // No channel was even opened for it.
    expect(h.driver.model.channels).toHaveLength(0);
  });

  it('refuses a queue whose type is not known, before sending', async () => {
    const h = harness();
    const { lease } = await connectPeek({
      ...h.options,
      queueTypes: queueTypes({}),
    });
    expect(await reasonOf(lease.get('who-knows'))).toBe('queue-type-unknown');
    expect(h.driver.model.channels).toHaveLength(0);
  });

  it('get returns a typed delivery with a bigint tag and a copied body, and null on an empty queue', async () => {
    const { lease } = await open([
      message(7, {
        body: 'hello',
        redelivered: true,
        headers: { 'x-delivery-count': 2, name: 'n' },
      }),
    ]);
    const delivery = await lease.get('q');
    expect(delivery).toMatchObject({
      tag: 7n,
      redelivered: true,
      exchange: '',
      routingKey: 'q',
    });
    expect(delivery?.headers['x-delivery-count']).toEqual({
      t: 'long',
      v: 2,
    });
    expect(delivery?.headers.name).toEqual({ t: 'string', v: 'n' });
    expect(new TextDecoder().decode(delivery?.body)).toBe('hello');
    expect(await lease.get('q')).toBeNull();
  });

  it('only one get runs at a time', async () => {
    const { lease, driver } = await open([message(1), message(2)]);
    await lease.get('q');
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const channel = driver.model.last();
    const slow = channel.get.bind(channel);
    channel.get = async (queue, options) => {
      await gate;
      return slow(queue, options);
    };
    const running = lease.get('q');
    expect(await reasonOf(lease.get('q'))).toBe('busy');
    unlock();
    await running;
  });

  it('stops asking the broker for more once the held cap is reached', async () => {
    const h = harness();
    const { lease } = await connectPeek({
      ...h.options,
      queueTypes: classicQueues,
      maxHeld: 2,
    });
    h.driver.model.onChannel = (channel) => {
      channel.scriptedGets = [message(1), message(2), message(3)];
    };
    await lease.get('q');
    await lease.get('q');
    expect(await reasonOf(lease.get('q'))).toBe('too-many-held');
    expect(h.driver.model.last().count('get')).toBe(2);
  });
});

describe('PeekLease cannot express a forbidden settle', () => {
  it('has exactly the peek methods: no reject, publish, consume or raw channel', async () => {
    const { lease } = await open();
    expect(Object.keys(lease).sort()).toEqual([
      'ackWithProof',
      'get',
      'nackRequeue',
      'qosBarrier',
      'release',
      'throwaway',
    ]);
    const loose = lease as unknown as Record<string, unknown>;
    for (const forbidden of [
      'reject',
      'nack',
      'ack',
      'publish',
      'consume',
      'channel',
      'raw',
      'connection',
    ]) {
      expect(loose[forbidden]).toBeUndefined();
    }
    expect(Object.isFrozen(lease)).toBe(true);
    expect(() => {
      loose.publish = () => undefined;
    }).toThrow(TypeError);
  });

  it.each([
    ['requeue false', { multiple: true, requeue: false }],
    ['multiple false', { multiple: false, requeue: true }],
    ['truthy but not true', { multiple: 'yes', requeue: 1 }],
    ['no options', undefined],
    ['null options', null],
  ])(
    'AC-1 nackRequeue with %s is refused at run time and nothing is sent',
    async (_name, options) => {
      const { lease, driver } = await open([message(1)]);
      await lease.get('q');
      expect(() => {
        lease.nackRequeue(1n, options as never);
      }).toThrow(
        expect.objectContaining({ reason: 'forbidden-settle' }) as Error,
      );
      expect(driver.model.last().count('nack')).toBe(0);
      expect(driver.model.last().unacked.size).toBe(1);
    },
  );

  it('a nack for a tag the lease does not hold is refused before it can close the channel', async () => {
    const { lease, driver } = await open([message(1), message(2)]);
    await lease.get('q');
    expect(() => {
      lease.nackRequeue(2n, REQUEUE_ALL);
    }).toThrow(
      expect.objectContaining({ reason: 'unknown-delivery-tag' }) as Error,
    );
    expect(driver.model.last().closed).toBe(false);
    // The held delivery is still returnable.
    lease.nackRequeue(1n, REQUEUE_ALL);
    expect(driver.model.last().unacked.size).toBe(0);
  });

  it('a nack before anything was delivered is refused', async () => {
    const { lease } = await open();
    expect(() => {
      lease.nackRequeue(1n, REQUEUE_ALL);
    }).toThrow(
      expect.objectContaining({ reason: 'unknown-delivery-tag' }) as Error,
    );
  });
});

describe('PeekLease ackWithProof (rescue)', () => {
  const forgeries = (): [string, unknown][] => {
    const real = mintConfirmedCopyProof({ destination: 'q', confirmedAt: 1 });
    return [
      [
        'an object literal',
        { kind: 'confirmed-copy', destination: 'q', confirmedAt: 1 },
      ],
      ['a spread copy of a real proof', { ...real }],
      ['a JSON round trip of a real proof', JSON.parse(JSON.stringify(real))],
      ['a structured clone of a real proof', structuredClone(real)],
      ['an object inheriting a real proof', Object.create(real)],
      ['a Proxy around a real proof', new Proxy(real, {})],
      ['a safe-return proof', mintSafeReturnProof({ reason: 'classic' })],
      ['a stream-credit proof', mintStreamCreditProof()],
      ['undefined', undefined],
      ['null', null],
      ['a string', 'confirmed-copy'],
    ];
  };

  it.each(forgeries())(
    'refuses %s with a ForgedProofError, sends nothing and keeps the delivery held',
    async (_name, forged) => {
      const { lease, driver } = await open([message(1)]);
      await lease.get('q');
      expect(() => {
        lease.ackWithProof(1n, forged as never);
      }).toThrow(ForgedProofError);
      const channel = driver.model.last();
      expect(channel.count('ack')).toBe(0);
      expect(channel.unacked.has(1)).toBe(true);
      // A real proof still settles it afterwards.
      lease.ackWithProof(
        1n,
        mintConfirmedCopyProof({ destination: 'q', confirmedAt: 1 }),
      );
      expect(channel.count('ack')).toBe(1);
    },
  );

  it('acks one delivery for a confirmed copy and for a destructive consent', async () => {
    const { lease, driver } = await open([message(1), message(2)]);
    await lease.get('q');
    await lease.get('q');
    lease.ackWithProof(
      1n,
      mintConfirmedCopyProof({ destination: 'q.quarantine', confirmedAt: 5 }),
    );
    lease.ackWithProof(2n, mintDestructiveConsentProof({ planHash: 'h' }));
    const acks = driver.model.last().calls.filter((c) => c.method === 'ack');
    expect(acks.map((c) => c.args)).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  it('the proof is checked before the tag: a forged proof for an unknown tag is a ForgedProofError', async () => {
    const { lease } = await open();
    expect(() => {
      lease.ackWithProof(99n, { kind: 'confirmed-copy' } as never);
    }).toThrow(ForgedProofError);
  });

  it('refuses an ack for a tag it does not hold or already settled, and a malformed tag', async () => {
    const { lease, driver } = await open([message(1)]);
    await lease.get('q');
    const proof = mintDestructiveConsentProof({ planHash: 'h' });
    expect(() => {
      lease.ackWithProof(2n, proof);
    }).toThrow(
      expect.objectContaining({ reason: 'unknown-delivery-tag' }) as Error,
    );
    lease.ackWithProof(1n, proof);
    expect(() => {
      lease.ackWithProof(1n, proof);
    }).toThrow(
      expect.objectContaining({ reason: 'unknown-delivery-tag' }) as Error,
    );
    expect(() => {
      lease.ackWithProof(0n, proof);
    }).toThrow(
      expect.objectContaining({ reason: 'unknown-delivery-tag' }) as Error,
    );
    expect(driver.model.last().closed).toBe(false);
  });

  it('after a rescue ack, the multiple nack names the highest tag still held', async () => {
    const { lease, driver } = await open([message(1), message(2), message(3)]);
    for (let i = 0; i < 3; i += 1) await lease.get('q');
    lease.ackWithProof(
      3n,
      mintConfirmedCopyProof({ destination: 'q.q', confirmedAt: 1 }),
    );
    // Tag 3 is gone: nacking up to it would be a 406 on the broker.
    expect(() => {
      lease.nackRequeue(3n, REQUEUE_ALL);
    }).toThrow(
      expect.objectContaining({ reason: 'unknown-delivery-tag' }) as Error,
    );
    lease.nackRequeue(2n, REQUEUE_ALL);
    expect(driver.model.last().closed).toBe(false);
    expect(driver.model.last().unacked.size).toBe(0);
  });
});

describe('PeekLease throwaway channels', () => {
  it('runs a passive declare on its own channel and closes it afterwards', async () => {
    const { lease, driver } = await open([message(1)]);
    await lease.get('q');
    driver.model.onChannel = (channel) => {
      channel.queues.set('q', { messageCount: 4, consumerCount: 1 });
    };
    const counts = await lease.throwaway((channel) => channel.checkQueue('q'));
    expect(counts).toEqual({ messageCount: 4, consumerCount: 1 });
    const [holding, throwaway] = driver.model.channels;
    expect(holding?.count('checkQueue')).toBe(0);
    expect(throwaway?.count('checkQueue')).toBe(1);
    expect(throwaway?.closed).toBe(true);
    expect(holding?.closed).toBe(false);
  });

  it('a 404 on a throwaway channel does not touch the holding channel', async () => {
    const { lease, driver } = await open([message(1)]);
    await lease.get('q');
    const error = await lease
      .throwaway((channel) => channel.checkQueue('missing'))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Amqp091Error);
    expect((error as Amqp091Error).code).toBe('NOT_FOUND');
    expect((error as Amqp091Error).broker?.code).toBe(404);
    const holding = driver.model.channels[0];
    expect(holding?.closed).toBe(false);
    expect(holding?.unacked.size).toBe(1);
  });

  it('allows only a few throwaway channels at once', async () => {
    const { lease, driver } = await open();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const running = Array.from({ length: 4 }, () =>
      lease.throwaway(() => gate),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await reasonOf(lease.throwaway(() => Promise.resolve()))).toBe(
      'busy',
    );
    finish();
    await Promise.all(running);
    await expect(lease.throwaway(() => Promise.resolve(1))).resolves.toBe(1);
    expect(driver.model.channels.every((channel) => channel.closed)).toBe(true);
  });

  it('the facade stops working once the callback returns', async () => {
    const { lease } = await open();
    let leaked:
      | Parameters<Parameters<PeekLease['throwaway']>[0]>[0]
      | undefined;
    await lease.throwaway((channel) => {
      leaked = channel;
      return Promise.resolve();
    });
    expect(await reasonOf(leaked?.checkQueue('q') ?? Promise.resolve())).toBe(
      'released',
    );
  });
});

describe('PeekLease release (DC-04: never close over held deliveries)', () => {
  it('healthy: returns what is still held (nack, then barrier) before it closes anything', async () => {
    const events: ConnectionEvent[] = [];
    const h = harness();
    const { lease, subscribe } = await connectPeek({
      ...h.options,
      queueTypes: classicQueues,
    });
    const listener: ConnectionListener = (event) => events.push(event);
    subscribe(listener);
    h.driver.model.onChannel = (channel) => {
      channel.scriptedGets = [message(1), message(2)];
    };
    await lease.get('q');
    await lease.get('q');
    const channel = h.driver.model.last();

    await lease.release('healthy');

    expect(channel.calls.map((call) => call.method)).toEqual([
      'get',
      'get',
      'nack',
      'prefetch',
      'close',
    ]);
    expect(channel.calls[2]?.args).toEqual([2, true, true]);
    expect(channel.unacked.size).toBe(0);
    expect(h.driver.model.closed).toBe(true);
    expect(h.dialer.closed).toBeGreaterThanOrEqual(1);
    expect(events).toContainEqual({ type: 'release-flush', count: 2 });
  });

  it('healthy after an explicit nack and barrier does not run a second barrier', async () => {
    const { lease, driver } = await open([message(1)]);
    await lease.get('q');
    lease.nackRequeue(1n, REQUEUE_ALL);
    await lease.qosBarrier(1);
    await lease.release('healthy');
    const channel = driver.model.channels[0];
    expect(channel?.count('prefetch')).toBe(1);
    expect(channel?.count('nack')).toBe(1);
    expect(channel?.calls.at(-1)?.method).toBe('close');
  });

  it('healthy with a nack but no barrier yet runs the barrier before closing', async () => {
    const { lease, driver } = await open([message(1)]);
    await lease.get('q');
    lease.nackRequeue(1n, REQUEUE_ALL);
    await lease.release('healthy');
    expect(driver.model.channels[0]?.calls.map((call) => call.method)).toEqual([
      'get',
      'nack',
      'prefetch',
      'close',
    ]);
  });

  it('healthy with nothing held just closes', async () => {
    const { lease, driver } = await open();
    await lease.release('healthy');
    expect(driver.model.channels).toHaveLength(0);
    expect(driver.model.closed).toBe(true);
  });

  it('poisoned closes at once: no nack, no barrier', async () => {
    const { lease, driver, dialer } = await open([message(1)]);
    await lease.get('q');
    await lease.release('poisoned');
    const channel = driver.model.channels[0];
    expect(channel?.count('nack')).toBe(0);
    expect(channel?.count('prefetch')).toBe(0);
    expect(driver.model.closed).toBe(true);
    expect(dialer.closed).toBeGreaterThanOrEqual(1);
  });

  it('release is idempotent and the lease is dead afterwards', async () => {
    const { lease } = await open([message(1)]);
    await lease.get('q');
    const first = lease.release('healthy');
    expect(lease.release('healthy')).toBe(first);
    await first;
    expect(await reasonOf(lease.get('q'))).toBe('released');
    expect(() => {
      lease.nackRequeue(1n, REQUEUE_ALL);
    }).toThrow(expect.objectContaining({ reason: 'released' }) as Error);
    expect(await reasonOf(lease.release('maybe' as never))).toBe(
      'invalid-argument',
    );
  });
});

describe('PeekLease when the channel or the connection is lost', () => {
  it('a channel closed by the broker loses the holds: the lease says so instead of sending', async () => {
    const { lease, driver } = await open([message(1), message(2)]);
    await lease.get('q');
    const channel = driver.model.last();
    channel.protocolError(404, 'NOT-FOUND');

    expect(() => {
      lease.nackRequeue(1n, REQUEUE_ALL);
    }).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }) as Error);
    expect(await reasonOf(lease.get('q'))).toBe('channel-closed');
    expect(channel.count('nack')).toBe(0);
  });

  it('a barrier that fails reports barrier-failed (the return is not confirmed)', async () => {
    const { lease, driver } = await open([message(1)]);
    await lease.get('q');
    const channel = driver.model.last();
    lease.nackRequeue(1n, REQUEUE_ALL);
    channel.prefetchGate = new Promise<void>(() => undefined);
    const barrier = lease.qosBarrier(1);
    channel.protocolError(503, 'COMMAND-INVALID');
    expect(await reasonOf(barrier)).toBe('barrier-failed');
  });

  it('a barrier that never gets an answer times out instead of hanging', async () => {
    const { lease, driver } = await open([message(1)], {
      operationTimeoutMs: 30,
    });
    await lease.get('q');
    driver.model.last().prefetchGate = new Promise<void>(() => undefined);
    lease.nackRequeue(1n, REQUEUE_ALL);
    expect(await reasonOf(lease.qosBarrier(1))).toBe('barrier-failed');
  });

  it('a get that is never answered is abandoned, but what is held can still be returned', async () => {
    const { lease, driver } = await open([message(1)], {
      operationTimeoutMs: 30,
    });
    await lease.get('q');
    const channel = driver.model.last();
    channel.get = () => new Promise(() => undefined);
    expect(await reasonOf(lease.get('q'))).toBe('timeout');
    // No new work on that channel...
    expect(await reasonOf(lease.get('q'))).toBe('timeout');
    // ...but the delivery it holds goes back by nack and barrier, not by a channel DOWN.
    lease.nackRequeue(1n, REQUEUE_ALL);
    await lease.qosBarrier(1);
    expect(channel.calls.map((call) => call.method)).toEqual([
      'get',
      'nack',
      'prefetch',
    ]);
    expect(channel.unacked.size).toBe(0);
  });

  it('release(healthy) after an abandoned get still returns the held deliveries first', async () => {
    const { lease, driver } = await open([message(1), message(2)], {
      operationTimeoutMs: 30,
    });
    await lease.get('q');
    await lease.get('q');
    const channel = driver.model.last();
    channel.get = () => new Promise(() => undefined);
    await reasonOf(lease.get('q'));
    await lease.release('healthy');
    expect(channel.calls.map((call) => call.method).slice(-3)).toEqual([
      'nack',
      'prefetch',
      'close',
    ]);
    expect(channel.unacked.size).toBe(0);
  });

  it('a lost connection stops every call with the reason the connection died', async () => {
    const { lease, driver } = await open([message(1)]);
    await lease.get('q');
    driver.model.drop(new Error('Heartbeat timeout'));
    expect(await reasonOf(lease.get('q'))).toBe('connection-closed');
  });
});
