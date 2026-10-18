// Integration test of the AMQP 0-9-1 adapter against lab brokers (M0-27). Run with
// `pnpm nx run adapter-amqp091:it --versions=4.2.9,4.3.6`; it needs a Docker daemon.
//
// Every connection goes through the real Dialer and its forwarder, so these tests also show that
// amqplib reaches the broker only through the local endpoint the Dialer offers (I-9).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Amqp091Error,
  connectControl,
  connectObserve,
  connectPeek,
  connectPublish,
  connectSource,
  type ConnectionEvent,
  type ConnectOptions,
} from '@app/adapter-amqp091';
import { createDialer } from '@app/net-dialer';
import { createTrustStore } from '@app/net-truststore';
import {
  mintDestructiveConsentProof,
  mintSafeReturnProof,
  type Delivery,
  type PublishOutcome,
} from '@app/ports';

import { startBroker } from '../broker-lab.ts';
import type { BrokerHandle } from '../lab/types.ts';

const versions = (process.env.IT_BROKER_VERSIONS ?? '4.3.6')
  .split(',')
  .filter((version) => version !== '');
const REQUEUE_ALL = { multiple: true, requeue: true } as const;
const MANDATORY = { mandatory: true, timeoutMs: 10_000 } as const;
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);
let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(process.pid)}-${String(counter)}`;
};

const portOf = (address: string | undefined): number => {
  if (address === undefined) throw new Error('the broker lacks that listener');
  return Number(new URL(address).port);
};

function optionsFor(
  broker: BrokerHandle,
  session: string,
  extra: Partial<ConnectOptions> = {},
): ConnectOptions {
  return {
    dialer: createDialer(),
    route: { kind: 'direct' },
    endpoint: { host: '127.0.0.1', port: portOf(broker.amqp) },
    credentials: {
      kind: 'plain',
      username: broker.credentials.username,
      password: broker.credentials.password,
    },
    name: { product: 'product', mode: 'it', session },
    heartbeatSeconds: 30,
    ...extra,
  };
}

async function management(
  broker: BrokerHandle,
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const auth = Buffer.from(
    `${broker.credentials.username}:${broker.credentials.password}`,
  ).toString('base64');
  const response = await fetch(`${broker.http}/api${path}`, {
    method,
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`${method} ${path} answered ${String(response.status)}`);
  }
  const raw = await response.text();
  return raw === '' ? undefined : JSON.parse(raw);
}

async function declare(
  broker: BrokerHandle,
  name: string,
  type: 'classic' | 'quorum' | 'stream',
): Promise<void> {
  await management(broker, 'PUT', `/queues/%2F/${encodeURIComponent(name)}`, {
    durable: true,
    arguments: { 'x-queue-type': type },
  });
}

async function fill(
  broker: BrokerHandle,
  queue: string,
  bodies: string[],
): Promise<void> {
  const { lease } = await connectPublish(optionsFor(broker, unique('fill')));
  for (const body of bodies) {
    const outcome = await lease.publish('', queue, text(body), {}, MANDATORY);
    expect(outcome.outcome).toBe('confirmed');
  }
  await lease.release();
}

describe.each(versions)('adapter-amqp091 against RabbitMQ %s', (version) => {
  let broker: BrokerHandle;

  beforeAll(async () => {
    broker = await startBroker({ version, variant: 'plain' });
  });
  afterAll(async () => {
    await broker.stop();
  });

  it('AC-2 get x3, nackRequeue(last, multiple), then the barrier resolves only after qos-ok and the messages are ready again', async () => {
    for (const type of ['classic', 'quorum'] as const) {
      const queue = unique(`ac2-${type}`);
      await declare(broker, queue, type);
      await fill(broker, queue, ['m1', 'm2', 'm3']);

      const { lease } = await connectPeek({
        ...optionsFor(broker, unique('peek')),
        queueTypes: { typeOf: () => type },
      });
      const got: Delivery[] = [];
      for (let i = 0; i < 3; i += 1) {
        const delivery = await lease.get(queue);
        expect(delivery).not.toBeNull();
        if (delivery !== null) got.push(delivery);
      }
      expect(got.map((d) => decode(d.body))).toEqual(['m1', 'm2', 'm3']);
      expect(got.every((d) => !d.redelivered)).toBe(true);

      // While held, the three messages are not ready.
      const held = await lease.throwaway((c) => c.checkQueue(queue));
      expect(held.messageCount).toBe(0);

      const last = got[2]?.tag;
      expect(last).toBeDefined();
      lease.nackRequeue(last ?? 0n, REQUEUE_ALL);
      await lease.qosBarrier(1);

      // The barrier answered, so the nack was processed: on a classic queue all three are ready
      // at once. A quorum queue applies the return through its Raft log, so its counts follow a
      // moment later; the delay is printed so it is on record (OQ-215).
      const started = Date.now();
      let ready = await lease.throwaway((c) => c.checkQueue(queue));
      const immediately = ready.messageCount;
      while (ready.messageCount !== 3 && Date.now() - started < 10_000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        ready = await lease.throwaway((c) => c.checkQueue(queue));
      }
      console.info(
        `RabbitMQ ${version} ${type}: ${String(immediately)} of 3 ready right after the barrier, all 3 after ${String(Date.now() - started)} ms`,
      );
      if (type === 'classic') expect(immediately).toBe(3);
      expect(ready.messageCount).toBe(3);

      const again = await lease.get(queue);
      expect(again).toMatchObject({ redelivered: true });
      expect(decode(again?.body ?? new Uint8Array())).toBe('m1');
      await lease.release('healthy');

      const after = await connectControl(optionsFor(broker, unique('ctl')));
      expect((await after.lease.checkQueue(queue)).messageCount).toBe(3);
      await after.lease.release();
    }
  });

  it('AC-2 a cached stream type makes get throw before sending, and the connection stays healthy', async () => {
    const queue = unique('stream');
    await declare(broker, queue, 'stream');
    const opened = await connectPeek({
      ...optionsFor(broker, unique('peek')),
      queueTypes: { typeOf: () => 'stream' },
    });
    const events: ConnectionEvent[] = [];
    opened.subscribe((event) => events.push(event));

    const error = await opened.lease
      .get(queue)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Amqp091Error);
    expect((error as Amqp091Error).reason).toBe('stream-get-refused');

    // Nothing was sent, so the broker did not close the connection with 540.
    const counts = await opened.lease.throwaway((c) => c.checkQueue(queue));
    expect(counts.consumerCount).toBe(0);
    expect(events.some((event) => event.type === 'closed')).toBe(false);
    await opened.lease.release('healthy');
  });

  it('a rescue ack with a destructive consent removes exactly the acked message; the rest return', async () => {
    const queue = unique('rescue');
    await declare(broker, queue, 'classic');
    await fill(broker, queue, ['a', 'b', 'c']);
    const { lease } = await connectPeek({
      ...optionsFor(broker, unique('peek')),
      queueTypes: { typeOf: () => 'classic' },
    });
    const first = await lease.get(queue);
    const second = await lease.get(queue);
    const third = await lease.get(queue);
    expect(third).not.toBeNull();
    lease.ackWithProof(
      third?.tag ?? 0n,
      mintDestructiveConsentProof({ planHash: 'it' }),
    );
    lease.nackRequeue(second?.tag ?? 0n, REQUEUE_ALL);
    await lease.qosBarrier(1);
    expect(
      (await lease.throwaway((c) => c.checkQueue(queue))).messageCount,
    ).toBe(2);
    expect(first).not.toBeNull();
    await lease.release('healthy');
  });

  it('release(healthy) with deliveries still held returns them before it closes', async () => {
    const queue = unique('flush');
    await declare(broker, queue, 'classic');
    await fill(broker, queue, ['x', 'y']);
    const opened = await connectPeek({
      ...optionsFor(broker, unique('peek')),
      queueTypes: { typeOf: () => 'classic' },
    });
    const events: ConnectionEvent[] = [];
    opened.subscribe((event) => events.push(event));
    await opened.lease.get(queue);
    await opened.lease.get(queue);
    await opened.lease.release('healthy');
    expect(events).toContainEqual({ type: 'release-flush', count: 2 });

    const control = await connectControl(optionsFor(broker, unique('ctl')));
    expect((await control.lease.checkQueue(queue)).messageCount).toBe(2);
    await control.lease.release();
  });

  it('a mandatory publish is confirmed with a proof when routed and returned (no proof) when not', async () => {
    const queue = unique('routed');
    await declare(broker, queue, 'classic');
    const { lease } = await connectPublish(optionsFor(broker, unique('pub')));

    const routed: PublishOutcome = await lease.publish(
      '',
      queue,
      text('hello'),
      { contentType: 'text/plain' },
      MANDATORY,
    );
    expect(routed.outcome).toBe('confirmed');
    expect(routed.outcome === 'confirmed' && routed.proof.destination).toBe(
      queue,
    );

    const lost = await lease.publish(
      '',
      unique('no-such-queue'),
      text('hello'),
      {},
      MANDATORY,
    );
    expect(lost.outcome).toBe('returned');
    expect('proof' in lost).toBe(false);

    expect(lease.blocked()).toBe(false);
    await lease.release();
  });

  it('typed headers survive a publish and a get; integers come back as long (amqplib erases the width)', async () => {
    const queue = unique('headers');
    await declare(broker, queue, 'classic');
    const pub = await connectPublish(optionsFor(broker, unique('pub')));
    await pub.lease.publish(
      '',
      queue,
      text('h'),
      {
        headers: {
          s: { t: 'string', v: 'text' },
          flag: { t: 'bool', v: true },
          small: { t: 'short', v: 7 },
          big: { t: 'long', v: 2 ** 40 },
          ratio: { t: 'double', v: 0.5 },
          when: { t: 'timestamp', v: 1_700_000_000 },
          list: { t: 'array', v: [{ t: 'string', v: 'a' }] },
          nested: { t: 'table', v: { k: { t: 'bool', v: false } } },
        },
      },
      MANDATORY,
    );
    await pub.lease.release();

    const { lease } = await connectPeek({
      ...optionsFor(broker, unique('peek')),
      queueTypes: { typeOf: () => 'classic' },
    });
    const delivery = await lease.get(queue);
    expect(delivery?.headers).toMatchObject({
      s: { t: 'string', v: 'text' },
      flag: { t: 'bool', v: true },
      small: { t: 'long', v: 7 },
      big: { t: 'long', v: 2 ** 40 },
      ratio: { t: 'double', v: 0.5 },
      when: { t: 'timestamp', v: 1_700_000_000 },
      list: { t: 'array', v: [{ t: 'string', v: 'a' }] },
      nested: { t: 'table', v: { k: { t: 'bool', v: false } } },
    });
    await lease.release('healthy');
  });

  it('the broker shows each connection under <product>/<mode>/<role>/<session>', async () => {
    const session = unique('named');
    const opened = await connectPeek({
      ...optionsFor(broker, session),
      queueTypes: { typeOf: () => 'classic' },
    });
    // The management API lists a connection once its statistics are first emitted (seconds).
    let names: (string | undefined)[] = [];
    await waitFor(async () => {
      const connections = (await management(broker, 'GET', '/connections')) as {
        client_properties?: { connection_name?: string };
      }[];
      names = connections.map((c) => c.client_properties?.connection_name);
      return names.includes(`product/it/peek/${session}`);
    }, 30_000);
    expect(names).toContain(`product/it/peek/${session}`);
    await opened.lease.release('healthy');
  });

  it('a source lease consumes with a prefetch, returns with a safe-return proof, and reports a server cancel', async () => {
    const queue = unique('source');
    await declare(broker, queue, 'classic');
    await fill(broker, queue, ['s1', 's2', 's3']);
    const opened = await connectSource(optionsFor(broker, unique('src')));
    const events: ConnectionEvent[] = [];
    opened.subscribe((event) => events.push(event));
    const received: (Delivery | null)[] = [];
    await opened.lease.consume(queue, 2, (delivery) => received.push(delivery));
    await waitFor(() => received.length >= 2);
    // Prefetch 2: no third message while two are unsettled.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received).toHaveLength(2);

    const [one, two] = received;
    opened.lease.nackRequeue(
      one?.tag ?? 0n,
      mintSafeReturnProof({ reason: 'classic' }),
    );
    await opened.lease.qosBarrier(1);
    opened.lease.ackWithProof(
      two?.tag ?? 0n,
      mintDestructiveConsentProof({ planHash: 'it' }),
    );
    await waitFor(() => received.length >= 4);

    // The queue is deleted under the consumer: the broker cancels it.
    await management(
      broker,
      'DELETE',
      `/queues/%2F/${encodeURIComponent(queue)}`,
    );
    await waitFor(() => received.at(-1) === null);
    expect(events.some((event) => event.type === 'server-cancel')).toBe(true);
    await opened.lease.release('poisoned');
  });

  it('an observe lease declares its tap queue, binds it, and reads copies it can ack', async () => {
    const exchange = unique('tapx');
    await management(broker, 'PUT', `/exchanges/%2F/${exchange}`, {
      type: 'fanout',
      durable: false,
    });
    const opened = await connectObserve(optionsFor(broker, unique('obs')));
    const name = `product.tap.${unique('t')}` as const;
    await opened.lease.declareTapQueue({
      name,
      exclusive: true,
      autoDelete: true,
      durable: false,
      args: {
        'x-queue-type': 'classic',
        'x-max-length': 100,
        'x-overflow': 'drop-head',
        'x-message-ttl': 60_000,
        'x-expires': 120_000,
        'x-product-session': 'it',
      },
    });
    await opened.lease.bindQueue(name, exchange, '', {});
    const seen: Delivery[] = [];
    await opened.lease.consume(name, 10, (delivery) => {
      if (delivery !== null) seen.push(delivery);
    });
    const pub = await connectPublish(optionsFor(broker, unique('pub')));
    await pub.lease.publish(exchange, '', text('tapped'), {}, MANDATORY);
    await waitFor(() => seen.length === 1);
    expect(decode(seen[0]?.body ?? new Uint8Array())).toBe('tapped');
    opened.lease.ackTap(seen[0]?.tag ?? 0n, false);
    await pub.lease.release();
    await opened.lease.release();
  });

  it('a passive declare of a missing queue is NOT_FOUND on its own channel and leaves the lease usable', async () => {
    const { lease } = await connectPeek({
      ...optionsFor(broker, unique('peek')),
      queueTypes: { typeOf: () => 'classic' },
    });
    const error = await lease
      .throwaway((c) => c.checkQueue(unique('missing')))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      reason: 'channel-closed',
    });
    expect((error as Amqp091Error).broker?.code).toBe(404);
    await expect(lease.get(unique('missing'))).rejects.toBeInstanceOf(
      Amqp091Error,
    );
    await lease.release('poisoned');
  });

  it('a refused login is auth-refused, and the endpoint is closed', async () => {
    const error = await connectControl(
      optionsFor(broker, unique('bad'), {
        credentials: { kind: 'plain', username: 'guest', password: 'wrong' },
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      reason: 'auth-refused',
      code: 'UNAUTHENTICATED',
    });
  });
});

describe('adapter-amqp091 over TLS (TrustStore, forwarder)', () => {
  const version = versions[0] ?? '4.3.6';
  let broker: BrokerHandle;

  beforeAll(async () => {
    broker = await startBroker({ version, variant: 'tls' });
  });
  afterAll(async () => {
    await broker.stop();
  });

  const tlsOptions = (
    trust: ReturnType<ReturnType<typeof createTrustStore>['forProfile']>,
  ): ConnectOptions => ({
    ...optionsFor(broker, unique('tls')),
    endpoint: {
      host: '127.0.0.1',
      port: portOf(broker.amqps),
      tls: trust,
    },
  });

  it('verifies the broker with the profile CA and a servername override', async () => {
    const ca = broker.tls?.ca ?? '';
    const trust = createTrustStore().forProfile({
      ca: [ca],
      servername: 'localhost',
    });
    const { lease, info } = await connectControl(tlsOptions(trust));
    expect(info.tlsInsecure).toBe(false);
    expect((await management(broker, 'GET', '/overview')) !== undefined).toBe(
      true,
    );
    await lease.release();
  });

  it('refuses a broker whose certificate it does not trust, and one under the wrong name', async () => {
    const store = createTrustStore();
    const untrusted = await connectControl(
      tlsOptions(store.forProfile()),
    ).catch((caught: unknown) => caught);
    expect(untrusted).toMatchObject({ code: 'TLS_UNTRUSTED' });

    const wrongName = await connectControl(
      tlsOptions(
        store.forProfile({
          ca: [broker.tls?.ca ?? ''],
          servername: 'elsewhere.example',
        }),
      ),
    ).catch((caught: unknown) => caught);
    expect(wrongName).toMatchObject({ code: 'TLS_UNTRUSTED' });
  });

  it('insecure=true connects and says so', async () => {
    const trust = createTrustStore().forProfile({ insecure: true });
    const { lease, info } = await connectControl(tlsOptions(trust));
    expect(info.tlsInsecure).toBe(true);
    await lease.release();
  });
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
