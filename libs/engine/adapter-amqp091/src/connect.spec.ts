import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { createTrustStore } from '@app/net-truststore';

import {
  connectControl,
  connectObserve,
  connectPeek,
  connectPublish,
  connectSource,
  formatConnectionName,
  parseConnectionName,
} from './connect.ts';
import type { ConnectionEvent } from './channel.ts';
import { Amqp091Error } from './errors.ts';
import { CANARY_PASSWORD, classicQueues, harness } from './testing/harness.ts';

const reasonOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Amqp091Error ? error.reason : error),
  );

describe('connection_name', () => {
  it('is <product>/<mode>/<role>/<session>', () => {
    expect(
      formatConnectionName({
        product: '<Product>',
        mode: 'server',
        role: 'peek',
        session: 'alice@example.com',
      }),
    ).toBe('<Product>/server/peek/alice@example.com');
  });

  it('parses back, and refuses what is not that shape', () => {
    expect(parseConnectionName('p/local/source/s-1')).toEqual({
      product: 'p',
      mode: 'local',
      role: 'source',
      session: 's-1',
    });
    expect(parseConnectionName('p/local/nobody/s-1')).toBeUndefined();
    expect(parseConnectionName('p/local/peek')).toBeUndefined();
    expect(parseConnectionName('p/local/peek/a/b')).toBeUndefined();
  });

  it.each(['', 'a/b', 'a b', 'a\nb', 'a\u0000b', 'x'.repeat(64), '-lead'])(
    'refuses the segment %j',
    (segment) => {
      expect(() =>
        formatConnectionName({
          product: 'p',
          mode: 'local',
          role: 'peek',
          session: segment,
        }),
      ).toThrow(Amqp091Error);
    },
  );

  it('refuses a role that is not one of the five', () => {
    expect(() =>
      formatConnectionName({
        product: 'p',
        mode: 'm',
        role: 'admin' as never,
        session: 's',
      }),
    ).toThrow(Amqp091Error);
  });
});

describe('opening a connection (I-9)', () => {
  it('asks the Dialer first, then hands amqplib only the forwarder path', async () => {
    const h = harness({
      endpoint: { host: 'broker.example', port: 5672, vhost: 'my vhost/%' },
    });
    const { info } = await connectControl(h.options);

    expect(h.dialer.targets).toEqual([
      { host: 'broker.example', port: 5672, purpose: 'amqp' },
    ]);
    const [connect] = h.driver.connects;
    expect(connect?.options.path).toBe('/tmp/fake-forwarder.sock');
    // The host amqplib sees is a documentation address: it can only be dialled by mistake.
    expect(connect?.target).toMatchObject({
      protocol: 'amqp',
      hostname: '192.0.2.1',
      heartbeat: 30,
    });
    expect(decodeURIComponent(connect?.target.vhost ?? '')).toBe('my vhost/%');
    expect(connect?.options.clientProperties).toEqual({
      connection_name: 'product/local/control/s1',
    });
    expect(info).toMatchObject({
      connectionName: 'product/local/control/s1',
      role: 'control',
      heartbeatSeconds: 30,
      tlsInsecure: false,
      serverVersion: '4.3.6',
    });
  });

  it('puts the role in the name for each of the five leases', async () => {
    const names: string[] = [];
    for (const connect of [
      (o: ReturnType<typeof harness>['options']) =>
        connectPeek({ ...o, queueTypes: classicQueues }),
      connectSource,
      connectPublish,
      connectObserve,
      connectControl,
    ]) {
      const h = harness();
      const opened = await connect(h.options);
      names.push(opened.info.connectionName);
    }
    expect(names).toEqual([
      'product/local/peek/s1',
      'product/local/source/s1',
      'product/local/publish/s1',
      'product/local/observe/s1',
      'product/local/control/s1',
    ]);
  });

  it('a refusal by the Dialer (egress policy) means amqplib is never called', async () => {
    const h = harness();
    h.dialer.failWith = new Error('EGRESS_DENIED');
    await expect(connectControl(h.options)).rejects.toThrow('EGRESS_DENIED');
    expect(h.driver.connects).toHaveLength(0);
  });

  it('a failed handshake closes the forwarder and says why, without the credentials', async () => {
    const h = harness();
    h.driver.failWith = new Error(
      'Handshake terminated by server: 403 (ACCESS-REFUSED)',
    );
    const error = await connectControl(h.options).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Amqp091Error);
    expect((error as Amqp091Error).reason).toBe('auth-refused');
    expect((error as Amqp091Error).code).toBe('UNAUTHENTICATED');
    // The endpoint is dropped (close is idempotent, so more than one path may ask).
    expect(h.dialer.closed).toBeGreaterThanOrEqual(1);
    expect(inspect(error, { depth: 6 })).not.toContain(CANARY_PASSWORD);
  });

  it('keeps the password out of everything the connection exposes', async () => {
    const h = harness();
    const opened = await connectPeek({
      ...h.options,
      queueTypes: classicQueues,
    });
    const dump = [
      inspect(opened, { depth: 8, showHidden: true }),
      JSON.stringify(opened.info),
      JSON.stringify(h.driver.connects[0]?.target),
      JSON.stringify(h.driver.connects[0]?.options),
      h.driver.connects[0]?.options.path ?? '',
    ].join('\n');
    expect(dump).not.toContain(CANARY_PASSWORD);
  });

  it('logs in with EXTERNAL when the profile uses a client certificate', async () => {
    const h = harness({ credentials: { kind: 'external' } });
    await connectControl(h.options);
    expect(h.driver.connects[0]?.options.credentials.mechanism).toBe(
      'EXTERNAL',
    );
  });

  it('amqps takes its TLS options from the TrustStore and reports an insecure override', async () => {
    const store = createTrustStore({
      includeSystem: false,
      runtime: {
        getCACertificates: () => [],
        setDefaultCACertificates: () => undefined,
      },
    });
    const secure = harness({
      endpoint: {
        host: '10.0.0.5',
        port: 5671,
        tls: store.forProfile({ servername: 'broker.internal' }),
      },
    });
    const a = await connectControl(secure.options);
    expect(secure.driver.connects[0]?.target.protocol).toBe('amqps');
    expect(secure.driver.connects[0]?.options.tls).toMatchObject({
      servername: 'broker.internal',
      rejectUnauthorized: true,
    });
    expect(a.info.tlsInsecure).toBe(false);

    const insecure = harness({
      endpoint: {
        host: '10.0.0.5',
        port: 5671,
        tls: store.forProfile({ insecure: true }),
      },
    });
    const b = await connectControl(insecure.options);
    expect(insecure.driver.connects[0]?.options.tls).toMatchObject({
      rejectUnauthorized: false,
    });
    expect(b.info.tlsInsecure).toBe(true);
  });

  it('validates its settings before it touches the network', async () => {
    for (const overrides of [
      { heartbeatSeconds: 0 },
      { heartbeatSeconds: 1.5 },
      { connectTimeoutMs: -1 },
      { operationTimeoutMs: 0 },
      { endpoint: { host: 'h', port: 1, vhost: 'a\nb' } },
      { name: { product: 'p', mode: 'm', session: 'a/b' } },
    ]) {
      const h = harness(overrides);
      expect(await reasonOf(connectControl(h.options))).toBe(
        'invalid-argument',
      );
      expect(h.dialer.targets).toHaveLength(0);
    }
  });

  it('an aborted signal stops before the Dialer is asked', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    await expect(connectControl(h.options)).rejects.toThrow();
    expect(h.dialer.targets).toHaveLength(0);
  });

  it('an abort during the handshake drops the endpoint and closes a connection that completes late', async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const connect = h.driver.connect.bind(h.driver);
    h.driver.connect = async (target, options) => {
      await gate;
      return connect(target, options);
    };
    const pending = connectControl(h.options);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await reasonOf(pending)).toBe('aborted');
    expect(h.dialer.closed).toBeGreaterThanOrEqual(1);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.driver.model.closed).toBe(true);
  });

  it('a handshake that never ends is cut off', async () => {
    const h = harness({ connectTimeoutMs: 20 });
    h.driver.connect = () => new Promise(() => undefined);
    expect(await reasonOf(connectControl(h.options))).toBe('timeout');
    expect(h.dialer.closed).toBeGreaterThanOrEqual(1);
  });
});

describe('what a connection reports', () => {
  it('delivers blocked, unblocked and closed events to subscribers, and survives a throwing one', async () => {
    const h = harness();
    const { subscribe } = await connectPublish(h.options);
    const events: ConnectionEvent[] = [];
    subscribe(() => {
      throw new Error('a bad subscriber');
    });
    const unsubscribe = subscribe((event) => events.push(event));

    h.driver.model.emit('blocked', 'low on memory');
    h.driver.model.emit('unblocked');
    h.driver.model.drop(new Error('Heartbeat timeout'));

    expect(events.map((event) => event.type)).toEqual([
      'blocked',
      'unblocked',
      'closed',
    ]);
    const closed = events.at(-1);
    expect(closed?.type === 'closed' && closed.error?.reason).toBe(
      'connection-closed',
    );
    unsubscribe();
  });

  it('closing the endpoint follows a lost connection', async () => {
    const h = harness();
    await connectControl(h.options);
    h.driver.model.drop(new Error('Socket closed abruptly'));
    expect(h.dialer.closed).toBeGreaterThanOrEqual(1);
  });

  it('allows a bounded number of subscribers', async () => {
    const h = harness();
    const { subscribe } = await connectControl(h.options);
    for (let index = 0; index < 8; index += 1) subscribe(() => undefined);
    expect(() => subscribe(() => undefined)).toThrow(Amqp091Error);
  });
});
