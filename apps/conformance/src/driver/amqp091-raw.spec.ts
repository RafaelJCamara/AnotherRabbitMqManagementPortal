// The raw driver against a scripted stand-in for amqplib. What the real library does on a real
// broker is recorded by the lab (the integration run of conformance:record); here the point is that
// the driver passes the settle arguments through unchanged, reports a closed channel instead of
// hiding it, and refuses an endpoint broker-lab did not create.
import { EventEmitter } from 'node:events';
import type { ChannelModel } from 'amqplib';
import { describe, expect, it } from 'vitest';

import { mintEndpoint } from '../testing/lab.ts';
import { Amqp091Raw, replyName } from './amqp091-raw.ts';
import { ForeignEndpointError, type LabEndpoint } from './lab-endpoint.ts';

class FakeChannel extends EventEmitter {
  readonly calls: unknown[][] = [];
  /** Messages `get` answers with, in order; `false` once empty. */
  gets: unknown[] = [];
  /** Called by `prefetch`; a test makes the broker close the channel here. */
  onPrefetch: (() => Promise<void>) | undefined;
  closed = false;
  consumed: ((message: unknown) => void) | undefined;
  failAssert: Error | undefined;
  /** Emitted as the channel 'error' event just after ssertQueue fails, as amqplib does. */
  closeReason: Error | undefined;

  private record(name: string, ...args: unknown[]): void {
    this.calls.push([name, ...args]);
  }
  private open(): void {
    if (this.closed) throw new Error('Channel closed');
  }
  assertQueue(queue: string, options: unknown): Promise<unknown> {
    this.record('assertQueue', queue, options);
    if (this.closeReason) {
      const reason = this.closeReason;
      setImmediate(() => this.emit('error', reason));
    }
    return this.failAssert
      ? Promise.reject(this.failAssert)
      : Promise.resolve({});
  }
  deleteQueue(queue: string): Promise<unknown> {
    this.record('deleteQueue', queue);
    return Promise.resolve({});
  }
  /** Messages checkQueue reports as ready. */
  ready = 0;
  checkQueue(queue: string): Promise<{ messageCount: number }> {
    this.record('checkQueue', queue);
    return Promise.resolve({ messageCount: this.ready });
  }
  assertExchange(
    exchange: string,
    kind: string,
    options: unknown,
  ): Promise<unknown> {
    this.record('assertExchange', exchange, kind, options);
    return Promise.resolve({});
  }
  deleteExchange(exchange: string): Promise<unknown> {
    this.record('deleteExchange', exchange);
    return Promise.resolve({});
  }
  bindQueue(queue: string, exchange: string, key: string): Promise<unknown> {
    this.record('bindQueue', queue, exchange, key);
    return Promise.resolve({});
  }
  /** Called by `get`; a test makes the broker refuse the get here. */
  onGet: (() => Promise<unknown>) | undefined;
  get(queue: string, options: unknown): Promise<unknown> {
    this.record('get', queue, options);
    if (this.onGet !== undefined) return this.onGet();
    return Promise.resolve(this.gets.length > 0 ? this.gets.shift() : false);
  }
  ack(message: { fields: { deliveryTag: number } }, multiple: boolean): void {
    this.open();
    this.record('ack', message.fields.deliveryTag, multiple);
  }
  nack(
    message: { fields: { deliveryTag: number } },
    multiple: boolean,
    requeue: boolean,
  ): void {
    this.open();
    this.record('nack', message.fields.deliveryTag, multiple, requeue);
  }
  reject(message: { fields: { deliveryTag: number } }, requeue: boolean): void {
    this.open();
    this.record('reject', message.fields.deliveryTag, requeue);
  }
  async prefetch(count: number): Promise<unknown> {
    this.record('prefetch', count);
    await this.onPrefetch?.();
    return {};
  }
  recover(): Promise<unknown> {
    this.record('recover');
    return Promise.resolve({});
  }
  consume(
    queue: string,
    onMessage: (message: unknown) => void,
  ): Promise<{ consumerTag: string }> {
    this.record('consume', queue);
    this.consumed = onMessage;
    return Promise.resolve({ consumerTag: 'ctag-1' });
  }
  cancel(tag: string): Promise<unknown> {
    this.record('cancel', tag);
    return Promise.resolve({});
  }
  close(): Promise<void> {
    this.record('close');
    this.closed = true;
    return Promise.resolve();
  }
  sendToQueue(
    queue: string,
    body: Buffer,
    options: unknown,
    callback: (error: unknown) => void,
  ): boolean {
    this.record('sendToQueue', queue, body.toString(), options);
    callback(this.publishError);
    return true;
  }
  publishError: unknown = null;
}

class FakeModel extends EventEmitter {
  readonly channels: FakeChannel[] = [];
  readonly confirm: FakeChannel[] = [];
  connection = {
    serverProperties: { version: '4.3.6' } as Record<string, unknown>,
  };
  closedCount = 0;
  createChannel(): Promise<FakeChannel> {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return Promise.resolve(channel);
  }
  createConfirmChannel(): Promise<FakeChannel> {
    const channel = new FakeChannel();
    this.confirm.push(channel);
    return Promise.resolve(channel);
  }
  close(): Promise<void> {
    this.closedCount += 1;
    return Promise.resolve();
  }
}

const connectTo = async (
  endpoint?: LabEndpoint,
): Promise<{ raw: Amqp091Raw; model: FakeModel; options: unknown[] }> => {
  const model = new FakeModel();
  const options: unknown[] = [];
  const raw = await Amqp091Raw.open(endpoint ?? (await mintEndpoint()), {
    connect: (opts) => {
      options.push(opts);
      return Promise.resolve(model as unknown as ChannelModel);
    },
  });
  return { raw, model, options };
};

/** Waits until the driver has registered its consumer. */
const listening = async (channel: FakeChannel): Promise<void> => {
  while (channel.consumed === undefined) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const main = (model: FakeModel): FakeChannel => {
  const channel = model.channels[1];
  if (channel === undefined) throw new Error('no main channel');
  return channel;
};

const admin = (model: FakeModel): FakeChannel => {
  const channel = model.channels[0];
  if (channel === undefined) throw new Error('no admin channel');
  return channel;
};

const message = (
  tag: number,
  extra: Record<string, unknown> = {},
  headers?: Record<string, unknown>,
) => ({
  content: Buffer.from('hello'),
  fields: { deliveryTag: tag, redelivered: false, ...extra },
  properties: { messageId: `m${String(tag)}`, headers },
});

describe('AC-2 the raw AMQP 0-9-1 driver connects only to what broker-lab created', () => {
  it('refuses a forged endpoint before it connects', async () => {
    let connects = 0;
    const forged = {
      version: '4.3.6',
      digest: 'sha256:x',
      host: '127.0.0.1',
      amqpPort: 5672,
      httpPort: 15672,
      credentials: { username: 'guest', password: 'guest' },
    } as unknown as LabEndpoint;

    await expect(
      Amqp091Raw.open(forged, {
        connect: () => {
          connects += 1;
          return Promise.reject(new Error('should not be called'));
        },
      }),
    ).rejects.toThrow(ForeignEndpointError);
    expect(connects).toBe(0);
  });

  it('connects with the endpoint host, port and login as options (never a URL string), and opens the main channel', async () => {
    const { options, model } = await connectTo();

    expect(options).toEqual([
      {
        protocol: 'amqp',
        hostname: '127.0.0.1',
        port: 49100,
        username: 'guest',
        password: 'guest',
        vhost: '/',
        heartbeat: 30,
      },
    ]);
    // One channel for declaring and deleting queues, which no scenario can close, and the main one.
    expect(model.channels).toHaveLength(2);
  });

  it('does not let a connection error crash the process', async () => {
    const { model } = await connectTo();

    expect(() =>
      model.emit('error', new Error('connection reset')),
    ).not.toThrow();
  });

  it('reports the version from the connection properties, or null', async () => {
    const { raw, model } = await connectTo();
    expect(raw.serverVersion()).toBe('4.3.6');

    model.connection.serverProperties = {};
    expect(raw.serverVersion()).toBeNull();
  });
});

describe('the raw driver performs every settle path, the forbidden ones too', () => {
  it('passes ack, nack and reject through with their own arguments (nack is not reject)', async () => {
    const { raw, model } = await connectTo();
    const channel = main(model);

    await raw.settle('main', 7, { kind: 'ack' });
    await raw.settle('main', 8, { kind: 'ack', multiple: true });
    await raw.settle('main', 9, { kind: 'nack', requeue: true });
    await raw.settle('main', 10, {
      kind: 'nack',
      requeue: false,
      multiple: true,
    });
    await raw.settle('main', 11, { kind: 'reject', requeue: true });
    await raw.settle('main', 12, { kind: 'reject', requeue: false });

    expect(channel.calls.filter((call) => call[0] !== 'prefetch')).toEqual([
      ['ack', 7, false],
      ['ack', 8, true],
      ['nack', 9, false, true],
      ['nack', 10, true, false],
      ['reject', 11, true],
      ['reject', 12, false],
    ]);
  });

  it('settles a tag the channel was never given, and waits for the broker with a round trip', async () => {
    const { raw, model } = await connectTo();
    const channel = main(model);

    const outcome = await raw.settle('main', 999, { kind: 'ack' });

    expect(outcome).toEqual({ channelOpen: true });
    expect(channel.calls).toEqual([
      ['ack', 999, false],
      ['prefetch', 0],
    ]);
  });

  it('reports a channel the broker closes, with the reply code and text, instead of throwing', async () => {
    const { raw, model } = await connectTo();
    const channel = main(model);
    channel.onPrefetch = () => {
      const error = Object.assign(
        new Error(
          'Channel closed by server: 406 (PRECONDITION-FAILED) with message "PRECONDITION_FAILED - unknown delivery tag 999"',
        ),
        { code: 406 },
      );
      channel.emit('error', error);
      channel.closed = true;
      return Promise.reject(
        new Error('Channel ended, no reply will be forthcoming'),
      );
    };

    const outcome = await raw.settle('main', 999, { kind: 'ack' });

    expect(outcome).toEqual({
      channelOpen: false,
      closed: {
        code: 406,
        text: 'Channel closed by server: 406 (PRECONDITION-FAILED) with message "PRECONDITION_FAILED - unknown delivery tag 999"',
      },
    });
  });

  it('a settle on a channel that is already closed is reported (the library refuses to send it)', async () => {
    const { raw, model } = await connectTo();
    await raw.openChannel('side');
    const side = model.channels[2];
    if (side === undefined) throw new Error('no side channel');
    await raw.closeChannel('side');

    const outcome = await raw.settle('side', 1, { kind: 'ack' });

    expect(outcome).toEqual({
      channelOpen: false,
      closed: { code: null, text: 'closed by the client' },
    });
    expect(side.calls.some((call) => call[0] === 'ack')).toBe(false);
  });

  it('a channel that fails with no broker event is reported with the library error', async () => {
    const { raw, model } = await connectTo();
    main(model).closed = true;

    const outcome = await raw.settle('main', 1, {
      kind: 'nack',
      requeue: true,
    });

    expect(outcome).toEqual({
      channelOpen: false,
      closed: { code: null, text: 'Channel closed' },
    });
  });

  it('a channel closed by the broker stays closed for the next settle', async () => {
    const { raw, model } = await connectTo();
    const channel = main(model);
    channel.onPrefetch = () => {
      channel.emit('error', Object.assign(new Error('boom'), { code: 406 }));
      channel.closed = true;
      return Promise.resolve();
    };

    await raw.settle('main', 1, { kind: 'ack' });
    const second = await raw.settle('main', 2, { kind: 'ack' });

    expect(second).toEqual({
      channelOpen: false,
      closed: { code: 406, text: 'boom' },
    });
  });

  it('keeps the prefetch of a channel when it waits for the broker', async () => {
    const { raw, model } = await connectTo();
    const channel = main(model);
    const pending = raw.consume('main', 'q', 2, 5_000);
    await listening(channel);
    channel.consumed?.(message(1));
    channel.consumed?.(message(2));
    await pending;

    await raw.settle('main', 1, { kind: 'ack' });

    expect(channel.calls.filter((call) => call[0] === 'prefetch')).toEqual([
      ['prefetch', 2],
      ['prefetch', 2],
    ]);
  });

  it('recovers a channel', async () => {
    const { raw, model } = await connectTo();

    await raw.recover('main');

    expect(main(model).calls).toEqual([['recover']]);
  });

  it('refuses to use a channel that was never opened, and to open one twice', async () => {
    const { raw } = await connectTo();

    await expect(raw.settle('nope', 1, { kind: 'ack' })).rejects.toThrow(
      /never opened/,
    );
    await raw.openChannel('side');
    await expect(raw.openChannel('side')).rejects.toThrow(/already open/);
  });
});

describe('the raw driver reads what the broker answers', () => {
  it('maps a get-ok: tag, redelivered, message id, size, remaining count and the counters', async () => {
    const { raw, model } = await connectTo();
    main(model).gets = [
      message(
        3,
        { redelivered: true, messageCount: 4 },
        { 'x-delivery-count': 2, 'x-acquired-count': 5n, 'x-other': 'ignored' },
      ),
    ];

    const delivery = await raw.get('main', 'q', false);

    expect(delivery).toEqual({
      tag: 3,
      redelivered: true,
      messageId: 'm3',
      bytes: 5,
      messageCount: 4,
      xDeliveryCount: 2,
      xAcquiredCount: 5,
    });
    expect(main(model).calls).toEqual([['get', 'q', { noAck: false }]]);
  });

  it('passes noAck through, and answers null for an empty queue', async () => {
    const { raw, model } = await connectTo();

    expect(await raw.get('main', 'q', true)).toBeNull();
    expect(main(model).calls).toEqual([['get', 'q', { noAck: true }]]);
  });

  it('records no counter that is missing, negative or not an integer', async () => {
    const { raw, model } = await connectTo();
    main(model).gets = [
      message(1, {}, { 'x-delivery-count': -1, 'x-acquired-count': 1.5 }),
    ];

    expect(await raw.get('main', 'q', true)).toMatchObject({
      xDeliveryCount: null,
      xAcquiredCount: null,
      messageCount: null,
    });
  });

  it('a message without an id has a null id', async () => {
    const { raw, model } = await connectTo();
    main(model).gets = [
      {
        content: Buffer.alloc(0),
        fields: { deliveryTag: 1, redelivered: false },
        properties: {},
      },
    ];

    expect(await raw.get('main', 'q', true)).toMatchObject({
      messageId: null,
      bytes: 0,
    });
  });

  it('consume sets the prefetch to the count, collects that many deliveries manually acknowledged, then cancels', async () => {
    const { raw, model } = await connectTo();
    const channel = main(model);
    const pending = raw.consume('main', 'q', 2, 5_000);
    await listening(channel);
    channel.consumed?.(null);
    channel.consumed?.(message(1));
    channel.consumed?.(message(2));

    const deliveries = await pending;

    expect(deliveries.map((delivery) => delivery.messageId)).toEqual([
      'm1',
      'm2',
    ]);
    expect(channel.calls).toEqual([
      ['prefetch', 2],
      ['consume', 'q'],
      ['cancel', 'ctag-1'],
    ]);
  });

  it('consume without cancel sends no basic.cancel and leaves the consumer active', async () => {
    const { raw, model } = await connectTo();
    const channel = main(model);
    const pending = raw.consume('main', 'q', 1, 5_000, false);
    await listening(channel);
    channel.consumed?.(message(1));

    await pending;

    expect(channel.calls).toEqual([
      ['prefetch', 1],
      ['consume', 'q'],
    ]);
  });

  it('readyCount is a passive declare on the admin channel, which the broker answers at once', async () => {
    const { raw, model } = await connectTo();
    admin(model).ready = 7;

    expect(await raw.readyCount('q')).toBe(7);
    expect(admin(model).calls).toEqual([['checkQueue', 'q']]);
    expect(main(model).calls).toEqual([]);
  });

  it('consume gives up after the timeout and returns what arrived', async () => {
    const { raw } = await connectTo();

    expect(await raw.consume('main', 'q', 3, 10)).toEqual([]);
  });

  it('declares a queue with its type as an argument, not durable or exclusive unless asked', async () => {
    const { raw, model } = await connectTo();

    await raw.declareQueue('q', {
      type: 'quorum',
      durable: true,
      arguments: { 'x-delivery-limit': 3 },
    });

    expect(admin(model).calls).toEqual([
      [
        'assertQueue',
        'q',
        {
          durable: true,
          exclusive: false,
          autoDelete: false,
          arguments: { 'x-delivery-limit': 3, 'x-queue-type': 'quorum' },
        },
      ],
    ]);
  });

  it('a type argument given by the scenario cannot override the queue type', async () => {
    const { raw, model } = await connectTo();

    await raw.declareQueue('q', {
      type: 'classic',
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });

    expect(admin(model).calls[0]?.[2]).toMatchObject({
      arguments: { 'x-queue-type': 'classic' },
    });
  });

  it('fails a call on a channel the broker closed with the broker text, not "Channel ended"', async () => {
    const { raw, model } = await connectTo();
    const channel = admin(model);
    channel.failAssert = new Error(
      'Channel ended, no reply will be forthcoming',
    );
    channel.closeReason = Object.assign(
      new Error('PRECONDITION_FAILED - transient queues are denied'),
      { code: 406 },
    );

    await expect(
      raw.declareQueue('q', { type: 'classic', durable: false, arguments: {} }),
    ).rejects.toThrow(
      /channel "\(admin\)" was closed: PRECONDITION_FAILED - transient queues are denied/,
    );
  });

  it('keeps the original error when the channel did not close', async () => {
    const { raw, model } = await connectTo();
    admin(model).failAssert = new Error('some other failure');

    await expect(
      raw.declareQueue('q', { type: 'classic', durable: true, arguments: {} }),
    ).rejects.toThrow('some other failure');
  });

  it('deletes a queue on the main channel', async () => {
    const { raw, model } = await connectTo();

    await raw.deleteQueue('q');

    expect(admin(model).calls).toEqual([['deleteQueue', 'q']]);
  });

  it('declares, binds and deletes an exchange on the admin channel (dead-letter topology)', async () => {
    const { raw, model } = await connectTo();

    await raw.declareExchange('dlx', 'direct');
    await raw.bindQueue('dlq', 'dlx', 'dlq');
    await raw.deleteExchange('dlx');

    expect(admin(model).calls).toEqual([
      ['assertExchange', 'dlx', 'direct', { durable: true, autoDelete: false }],
      ['bindQueue', 'dlq', 'dlx', 'dlq'],
      ['deleteExchange', 'dlx'],
    ]);
  });
});

describe('publish', () => {
  it('goes to the default exchange on a confirm channel, with the message id, and waits for the confirm', async () => {
    const { raw, model } = await connectTo();

    await raw.publish('q', { messageId: 'm1', body: Buffer.from('payload') });
    await raw.publish('q', { messageId: 'm2', body: Buffer.from('more') });

    expect(model.confirm).toHaveLength(1);
    expect(model.confirm[0]?.calls).toEqual([
      ['sendToQueue', 'q', 'payload', { messageId: 'm1' }],
      ['sendToQueue', 'q', 'more', { messageId: 'm2' }],
    ]);
    expect(main(model).calls).toEqual([]);
  });

  it('sends a copied x-delivery-count as the only header, and none when the scenario sets none', async () => {
    const { raw, model } = await connectTo();

    await raw.publish('q', {
      messageId: 'm1',
      body: Buffer.from('a'),
      headers: { 'x-delivery-count': 99 },
    });

    expect(model.confirm[0]?.calls).toEqual([
      [
        'sendToQueue',
        'q',
        'a',
        { messageId: 'm1', headers: { 'x-delivery-count': 99 } },
      ],
    ]);
  });

  it('fails when the broker does not confirm', async () => {
    const { raw, model } = await connectTo();
    await raw.publish('q', { messageId: 'm1', body: Buffer.from('x') });
    const confirm = model.confirm[0];
    if (confirm === undefined) throw new Error('no confirm channel');

    confirm.publishError = new Error('nacked');
    await expect(
      raw.publish('q', { messageId: 'm2', body: Buffer.from('x') }),
    ).rejects.toThrow('nacked');
    confirm.publishError = true;
    await expect(
      raw.publish('q', { messageId: 'm3', body: Buffer.from('x') }),
    ).rejects.toThrow(/did not confirm/);
  });

  it('closes the connection, and survives it already being gone', async () => {
    const { raw, model } = await connectTo();
    model.close = () => Promise.reject(new Error('already closed'));

    await expect(raw.close()).resolves.toBeUndefined();
  });
});

describe('refusals reported by the raw driver (M0-41 slice A)', () => {
  it('AC-3 a refusal is reported at the level the broker closed, and a dead connection is passed over', async () => {
    const models = [new FakeModel(), new FakeModel()];
    let made = 0;
    const raw = await Amqp091Raw.open(await mintEndpoint(), {
      connect: () => {
        made += 1;
        return Promise.resolve(models[made - 1] as unknown as ChannelModel);
      },
    });
    const [primary, second] = models as [FakeModel, FakeModel];
    const channel = main(primary);

    // Not a broker reply: a socket error (a string code) or a failure with no reason is rethrown,
    // and a connection error without a numeric code does not make the connection dead.
    primary.emit(
      'error',
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    );
    channel.onGet = () => Promise.reject(new Error('read ECONNRESET'));
    await expect(raw.tryGet('main', 'q', false)).rejects.toThrow(
      'read ECONNRESET',
    );
    channel.onGet = undefined;

    // Channel level: the broker closed one channel; the reply name is read, its text is not kept.
    await raw.openChannel('side');
    const side = primary.channels[2];
    if (side === undefined) throw new Error('no side channel');
    side.onGet = () => {
      side.emit(
        'error',
        Object.assign(
          new Error(
            "Channel closed by server: 405 (RESOURCE-LOCKED) with message \"RESOURCE_LOCKED - cannot obtain access to locked queue 'lab-q-9f3' in vhost '/'\"",
          ),
          { code: 405 },
        ),
      );
      side.closed = true;
      return Promise.reject(
        new Error('Channel ended, no reply will be forthcoming'),
      );
    };
    const channelLevel = await raw.tryGet('side', 'lab-q-9f3', false);
    expect(channelLevel).toEqual({
      refused: true,
      refusal: { level: 'channel', code: 405, reply: 'RESOURCE_LOCKED' },
    });
    expect(JSON.stringify(channelLevel)).not.toContain('lab-q-9f3');
    // The channel stays closed; a second get on it was never answered by the broker, so it aborts.
    await expect(raw.tryGet('side', 'q', false)).rejects.toThrow(
      /closed before the get/,
    );

    // Connection level: every channel of `probe` dies with it, and each reads as refused.
    await raw.openConnection('probe');
    await raw.openChannel('p1', 'probe');
    await raw.openChannel('p2', 'probe');
    const [p1, p2] = second.channels;
    if (p1 === undefined || p2 === undefined)
      throw new Error('no probe channels');
    p1.onGet = () => {
      second.emit(
        'error',
        Object.assign(
          new Error(
            'Connection closed: 540 (NOT-IMPLEMENTED) with message "NOT_IMPLEMENTED - basic.get is not supported for stream \'lab-q-9f3\'"',
          ),
          { code: 540 },
        ),
      );
      p1.emit('close');
      p2.emit('close');
      return Promise.reject(
        new Error('Channel ended, no reply will be forthcoming'),
      );
    };
    const expected = {
      refused: true,
      refusal: { level: 'connection', code: 540, reply: 'NOT_IMPLEMENTED' },
    };
    expect(await raw.tryGet('p1', 'lab-q-9f3', false)).toEqual(expected);
    expect(await raw.tryGet('p2', 'lab-q-9f3', false)).toEqual(expected);
    expect(p2.calls.some((call) => call[0] === 'get')).toBe(false);
    expect(await raw.settle('p2', 1, { kind: 'ack' })).toEqual({
      channelOpen: false,
      closed: { code: null, text: 'closed with its connection' },
    });

    // The dead connection is passed over, and `main` is unaffected.
    await expect(raw.closeConnection('probe')).resolves.toBeUndefined();
    expect(second.closedCount).toBe(0);
    channel.gets = [message(5)];
    expect(await raw.tryGet('main', 'q', false)).toMatchObject({
      refused: false,
      value: { tag: 5 },
    });
    expect(await raw.tryGet('main', 'q', false)).toEqual({
      refused: false,
      value: null,
    });
    await expect(raw.close()).resolves.toBeUndefined();
    expect([primary.closedCount, second.closedCount]).toEqual([1, 0]);

    // A name is read only from the library's own wording of a close.
    expect(
      replyName(
        'Channel closed by server: 406 (PRECONDITION-FAILED) with message "x"',
      ),
    ).toBe('PRECONDITION_FAILED');
    for (const text of [
      'boom',
      'closed: 405 (lower-case)',
      'Channel closed by server: 405 with message "x"',
    ]) {
      expect(replyName(text)).toBe('unparsed');
    }
  });
});

describe('AC-4 a second connection that can go away', () => {
  it('AC-4 closing the holder connection leaves the observer connection usable and records the close', async () => {
    const models = [new FakeModel(), new FakeModel()];
    const options: unknown[] = [];
    const raw = await Amqp091Raw.open(await mintEndpoint(), {
      connect: (opts) => {
        options.push(opts);
        return Promise.resolve(
          models[options.length - 1] as unknown as ChannelModel,
        );
      },
    });
    const [primary, second] = models as [FakeModel, FakeModel];
    await raw.openConnection('holder');
    await raw.openChannel('h', 'holder');
    const holderChannel = second.channels[0];
    if (holderChannel === undefined) throw new Error('no holder channel');
    holderChannel.gets = [message(1)];
    main(primary).gets = [message(2)];

    // The holder's channel is on the second connection and holds a delivery.
    expect(await raw.get('h', 'q', false)).toMatchObject({ tag: 1 });
    expect(options).toHaveLength(2);
    expect(options[1]).toEqual(options[0]);
    await raw.closeConnection('holder');

    expect([primary.closedCount, second.closedCount]).toEqual([0, 1]);
    // The settle on the holder's channel reports the closure; it does not throw.
    expect(await raw.settle('h', 1, { kind: 'ack' })).toEqual({
      channelOpen: false,
      closed: { code: null, text: 'closed with its connection' },
    });
    // The observer's connection still works: a get, a settle, a count and a declare.
    expect(await raw.get('main', 'q', true)).toMatchObject({ tag: 2 });
    expect(await raw.settle('main', 2, { kind: 'ack' })).toEqual({
      channelOpen: true,
    });
    admin(primary).ready = 4;
    expect(await raw.readyCount('q')).toBe(4);
    // A name is used once; the default connection is never closed by a scenario.
    await expect(raw.closeConnection('holder')).rejects.toThrow(/not open/);
    await expect(raw.openConnection('holder')).rejects.toThrow(/already used/);
    await expect(raw.closeConnection('main')).rejects.toThrow(/never closed/);
    await expect(raw.openChannel('x', 'holder')).rejects.toThrow(/not open/);
    await expect(raw.openChannel('y', 'nope')).rejects.toThrow(/not open/);

    await raw.close();
    expect([primary.closedCount, second.closedCount]).toEqual([1, 1]);
  });
});
