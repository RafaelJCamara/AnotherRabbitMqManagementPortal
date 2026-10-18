// A scripted stand-in for the AMQP client library, for the lease specs. It behaves like the broker
// where it matters to the invariants: it tracks unacknowledged deliveries per channel, and a settle
// for a tag it does not hold is a 406 that closes the channel (which, on a real broker, returns
// every other held delivery). Not part of the package API.
import { EventEmitter } from 'node:events';

import type { DialerPort } from '@app/ports';

import type {
  Amqp091Driver,
  AmqpChannel,
  AmqpConnectTarget,
  AmqpLogin,
  AmqpMessage,
  AmqpModel,
  AmqpQueueOptions,
  AmqpSettleTarget,
  AmqpSocketOptions,
} from '../driver.ts';

export interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

export function message(
  tag: number,
  options: {
    body?: string;
    headers?: Record<string, unknown>;
    redelivered?: boolean;
    queue?: string;
  } = {},
): AmqpMessage {
  return {
    content: Buffer.from(options.body ?? `body-${String(tag)}`),
    fields: {
      deliveryTag: tag,
      redelivered: options.redelivered ?? false,
      exchange: '',
      routingKey: options.queue ?? 'q',
      consumerTag: 'ctag-1',
    },
    properties: {
      contentType: 'text/plain',
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    },
  };
}

export type ConfirmMode = 'ack' | 'nack' | 'never' | 'return' | 'error';

export class FakeChannel extends EventEmitter {
  readonly calls: Call[] = [];
  readonly confirm: boolean;
  /** Messages `get` hands out, in order; an Error rejects the call. */
  scriptedGets: (AmqpMessage | false | Error)[] = [];
  /** Queue name to counts for `checkQueue`; a missing queue is a 404 that closes the channel. */
  queues = new Map<string, { messageCount: number; consumerCount: number }>();
  /** While set, `prefetch` (the qos barrier) waits for it, like a broker that has not answered. */
  prefetchGate: Promise<void> | undefined;
  confirmMode: ConfirmMode = 'ack';
  /** Callbacks of publishes the broker has not answered (mode `never`). */
  readonly pendingConfirms: ((error: unknown) => void)[] = [];
  closed = false;
  readonly unacked = new Set<number>();
  #consumer: ((message: AmqpMessage | null) => void) | undefined;

  constructor(confirm: boolean) {
    super();
    this.confirm = confirm;
  }

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  #record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  /** The broker closes the channel with a reply code, as RabbitMQ does for 404, 405 and 406. */
  protocolError(code: number, text: string): void {
    if (this.closed) return;
    this.closed = true;
    this.unacked.clear();
    const error = Object.assign(
      new Error(`Channel closed by server: ${String(code)} (${text})`),
      { code, classId: 60, methodId: 70 },
    );
    this.emit('error', error);
    this.emit('close');
  }

  #check(): void {
    if (this.closed) {
      throw Object.assign(new Error('Channel closed'), {
        name: 'IllegalOperationError',
      });
    }
  }

  get(
    queue: string,
    options: { noAck: boolean },
  ): Promise<AmqpMessage | false> {
    this.#record('get', queue, options);
    this.#check();
    const next = this.scriptedGets.shift();
    if (next instanceof Error) return Promise.reject(next);
    if (next === undefined || next === false) return Promise.resolve(false);
    this.unacked.add(next.fields.deliveryTag);
    return Promise.resolve(next);
  }

  ack(target: AmqpSettleTarget, allUpTo?: boolean): void {
    this.#record('ack', target.fields.deliveryTag, allUpTo ?? false);
    this.#check();
    this.#settle(target.fields.deliveryTag, allUpTo ?? false);
  }

  nack(target: AmqpSettleTarget, allUpTo?: boolean, requeue?: boolean): void {
    this.#record('nack', target.fields.deliveryTag, allUpTo ?? false, requeue);
    this.#check();
    this.#settle(target.fields.deliveryTag, allUpTo ?? false);
  }

  #settle(tag: number, multiple: boolean): void {
    if (!this.unacked.has(tag)) {
      this.protocolError(406, 'PRECONDITION-FAILED');
      return;
    }
    if (multiple) {
      for (const held of [...this.unacked]) {
        if (held <= tag) this.unacked.delete(held);
      }
    } else {
      this.unacked.delete(tag);
    }
  }

  async prefetch(count: number, global?: boolean): Promise<unknown> {
    this.#record('prefetch', count, global ?? false);
    this.#check();
    await this.prefetchGate;
    this.#check();
    return {};
  }

  consume(
    queue: string,
    onMessage: (message: AmqpMessage | null) => void,
    options: { noAck: boolean },
  ): Promise<{ consumerTag: string }> {
    this.#record('consume', queue, options);
    this.#check();
    this.#consumer = onMessage;
    return Promise.resolve({ consumerTag: 'ctag-1' });
  }

  /** A delivery for the consumer, as the broker would send it. */
  deliver(next: AmqpMessage): void {
    this.unacked.add(next.fields.deliveryTag);
    this.#consumer?.(next);
  }

  /** The broker cancelled the consumer (queue deleted). */
  cancelFromServer(): void {
    this.#consumer?.(null);
  }

  cancel(consumerTag: string): Promise<unknown> {
    this.#record('cancel', consumerTag);
    this.#check();
    return Promise.resolve({});
  }

  checkQueue(
    queue: string,
  ): Promise<{ messageCount: number; consumerCount: number }> {
    this.#record('checkQueue', queue);
    this.#check();
    const counts = this.queues.get(queue);
    if (counts === undefined) {
      this.protocolError(404, 'NOT-FOUND');
      return Promise.reject(
        Object.assign(
          new Error('Operation failed: QueueDeclare; 404 (NOT-FOUND)'),
          { code: 404, classId: 50, methodId: 10 },
        ),
      );
    }
    return Promise.resolve(counts);
  }

  checkExchange(exchange: string): Promise<unknown> {
    this.#record('checkExchange', exchange);
    this.#check();
    return Promise.resolve({});
  }

  assertQueue(queue: string, options: AmqpQueueOptions): Promise<unknown> {
    this.#record('assertQueue', queue, options);
    this.#check();
    return Promise.resolve({});
  }

  bindQueue(
    queue: string,
    source: string,
    pattern: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.#record('bindQueue', queue, source, pattern, args);
    this.#check();
    return Promise.resolve({});
  }

  unbindQueue(
    queue: string,
    source: string,
    pattern: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.#record('unbindQueue', queue, source, pattern, args);
    this.#check();
    return Promise.resolve({});
  }

  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Record<string, unknown>,
    callback: (error: unknown) => void,
  ): boolean {
    this.#record('publish', exchange, routingKey, content, options);
    this.#check();
    switch (this.confirmMode) {
      case 'ack':
        queueMicrotask(() => {
          callback(null);
        });
        break;
      case 'return':
        // The broker returns an unroutable mandatory message, then confirms it.
        queueMicrotask(() => {
          this.emit('return', {
            content,
            fields: {
              deliveryTag: 0,
              redelivered: false,
              exchange,
              routingKey,
              replyCode: 312,
              replyText: 'NO_ROUTE',
            },
            properties: {},
          });
          callback(null);
        });
        break;
      case 'nack':
        queueMicrotask(() => {
          callback(new Error('message nacked'));
        });
        break;
      case 'error':
        // No such exchange: the broker closes the channel, and the pending confirm fails.
        queueMicrotask(() => {
          this.protocolError(404, 'NOT-FOUND');
          callback(new Error('channel closed'));
        });
        break;
      case 'never':
        // The test answers by hand, when it wants to.
        this.pendingConfirms.push(callback);
        break;
    }
    return true;
  }

  close(): Promise<void> {
    this.#record('close');
    if (!this.closed) {
      this.closed = true;
      this.emit('close');
    }
    return Promise.resolve();
  }
}

export class FakeModel extends EventEmitter {
  readonly channels: FakeChannel[] = [];
  readonly connection = { serverProperties: { version: '4.3.6' } };
  closed = false;
  /** Make `createChannel` / `createConfirmChannel` pause, like a busy broker. */
  openGate: Promise<void> | undefined;
  onChannel: ((channel: FakeChannel) => void) | undefined;

  async createChannel(): Promise<AmqpChannel> {
    return this.#open(false);
  }

  async createConfirmChannel(): Promise<AmqpChannel> {
    return this.#open(true);
  }

  async #open(confirm: boolean): Promise<AmqpChannel> {
    await this.openGate;
    const channel = new FakeChannel(confirm);
    this.channels.push(channel);
    this.onChannel?.(channel);
    return channel;
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const channel of this.channels) {
        if (!channel.closed) {
          channel.closed = true;
          channel.emit('close');
        }
      }
      this.emit('close');
    }
    return Promise.resolve();
  }

  /** The socket died under the connection. */
  drop(error?: Error): void {
    this.closed = true;
    if (error !== undefined) this.emit('error', error);
    this.emit('close', error);
  }

  last(): FakeChannel {
    const channel = this.channels.at(-1);
    if (channel === undefined) throw new Error('no channel was opened');
    return channel;
  }
}

export class FakeDriver implements Amqp091Driver {
  readonly connects: {
    target: AmqpConnectTarget;
    options: AmqpSocketOptions;
  }[] = [];
  readonly model = new FakeModel();
  failWith: Error | undefined;

  connect(
    target: AmqpConnectTarget,
    options: AmqpSocketOptions,
  ): Promise<AmqpModel> {
    this.connects.push({ target, options });
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(this.model as unknown as AmqpModel);
  }

  plain(username: string, password: string): AmqpLogin {
    // The response is what goes on the wire; the object itself keeps nothing readable.
    const response = Buffer.from(`\u0000${username}\u0000${password}`);
    return { mechanism: 'PLAIN', response: () => response };
  }

  external(): AmqpLogin {
    return { mechanism: 'EXTERNAL', response: () => Buffer.alloc(0) };
  }
}

export class FakeDialer implements Pick<DialerPort, 'forwarder'> {
  readonly targets: { host: string; port: number; purpose: string }[] = [];
  closed = 0;
  failWith: Error | undefined;

  forwarder(target: {
    host: string;
    port: number;
    purpose: string;
  }): Promise<{ path: string; close(): Promise<void> }> {
    this.targets.push(target);
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve({
      path: '/tmp/fake-forwarder.sock',
      close: () => {
        this.closed += 1;
        return Promise.resolve();
      },
    });
  }
}
