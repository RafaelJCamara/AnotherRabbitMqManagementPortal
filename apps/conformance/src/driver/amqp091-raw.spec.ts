// The raw driver against a scripted stand-in for amqplib. What the real library does on a real
// broker is recorded by the lab (the integration run of conformance:record); here the point is that
// the driver passes the settle arguments through unchanged, reports a closed channel instead of
// hiding it, and refuses an endpoint broker-lab did not create.
import { EventEmitter } from 'node:events';
import type { ChannelModel } from 'amqplib';
import { describe, expect, it } from 'vitest';

import { mintEndpoint } from '../testing/lab.ts';
import { Amqp091Raw } from './amqp091-raw.ts';
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
  get(queue: string, options: unknown): Promise<unknown> {
    this.record('get', queue, options);
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
