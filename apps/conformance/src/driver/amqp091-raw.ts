// Raw AMQP 0-9-1 for the lab (amqplib; confined to this project and the adapter, I-11). It does what
// the product's adapter must never do: settle a delivery from the wrong channel, settle a tag that
// was never delivered, settle twice, settle after the channel is gone, and recover. Each of those
// is a "forbidden" settle path, and what the broker does about it is exactly what a conformance
// cell records, so nothing here hides a failure: a channel the broker closes is reported, with the
// reply code and text, instead of thrown.
//
// It reaches only a `LabEndpoint` (the check is in `lab-endpoint.ts`) and records no credential.
import {
  connect as amqplibConnect,
  type ChannelModel,
  type Channel,
  type ConfirmChannel,
  type GetMessage,
  type Message,
  type Options,
} from 'amqplib';

import { assertLabEndpoint, type LabEndpoint } from './lab-endpoint.ts';

export type QueueType = 'classic' | 'quorum' | 'stream';

export interface RawDelivery {
  readonly tag: number;
  readonly redelivered: boolean;
  readonly messageId: string | null;
  readonly bytes: number;
  /** Ready messages left in the queue after this one (`basic.get-ok` only). */
  readonly messageCount: number | null;
  readonly xDeliveryCount: number | null;
  readonly xAcquiredCount: number | null;
}

export type SettleAction =
  | { readonly kind: 'ack'; readonly multiple?: boolean }
  | {
      readonly kind: 'nack';
      readonly requeue: boolean;
      readonly multiple?: boolean;
    }
  | { readonly kind: 'reject'; readonly requeue: boolean };

/** What the broker (or the client library) did about a settle. */
export type SettleOutcome =
  | { readonly channelOpen: true }
  | {
      readonly channelOpen: false;
      /** The broker's reply code and text, or the library's refusal to send on a closed channel. */
      readonly closed: { readonly code: number | null; readonly text: string };
    };

export interface RawDeps {
  readonly connect?: (options: Options.Connect) => Promise<ChannelModel>;
}

interface ChannelState {
  readonly channel: Channel;
  /** The connection the channel belongs to. */
  readonly connection: string;
  prefetch: number;
  closed?: { code: number | null; text: string };
}

interface ConnectionState {
  readonly model: ChannelModel;
  open: boolean;
}

const MAIN = 'main';
/** Declares and deletes queues, and is never given to a scenario: a forbidden settle cannot close it. */
const ADMIN = '(admin)';
const PUBLISHER = '(publisher)';

const counter = (value: unknown): number | null => {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
};

const closeInfo = (error: unknown): { code: number | null; text: string } => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? counter(error.code)
      : null;
  return {
    code,
    text: error instanceof Error ? error.message : String(error),
  };
};

function toDelivery(message: GetMessage | Message): RawDelivery {
  const headers = message.properties.headers as
    | Record<string, unknown>
    | undefined;
  const { messageCount } = message.fields as { messageCount?: unknown };
  return {
    tag: message.fields.deliveryTag,
    redelivered: message.fields.redelivered,
    messageId:
      typeof message.properties.messageId === 'string'
        ? message.properties.messageId
        : null,
    bytes: message.content.length,
    messageCount: counter(messageCount),
    xDeliveryCount: counter(headers?.['x-delivery-count']),
    xAcquiredCount: counter(headers?.['x-acquired-count']),
  };
}

export class Amqp091Raw {
  readonly #connect: () => Promise<ChannelModel>;
  readonly #connections = new Map<string, ConnectionState>();
  readonly #channels = new Map<string, ChannelState>();

  private constructor(
    connect: () => Promise<ChannelModel>,
    model: ChannelModel,
  ) {
    this.#connect = connect;
    this.#adopt(MAIN, model);
  }

  #adopt(name: string, model: ChannelModel): void {
    // A connection the broker drops must not crash the process; the next call fails instead.
    model.on('error', () => undefined);
    this.#connections.set(name, { model, open: true });
  }

  /** Connects to a broker that testing/broker-lab created; any other endpoint is refused. */
  static async open(
    endpoint: LabEndpoint,
    deps: RawDeps = {},
  ): Promise<Amqp091Raw> {
    assertLabEndpoint(endpoint);
    const connectWith = deps.connect ?? ((options) => amqplibConnect(options));
    // Every connection of a run (the default one and any a scenario opens) is made the same way.
    const connect = (): Promise<ChannelModel> =>
      connectWith({
        protocol: 'amqp',
        hostname: endpoint.host,
        port: endpoint.amqpPort,
        username: endpoint.credentials.username,
        password: endpoint.credentials.password,
        vhost: '/',
        heartbeat: 30,
      });
    const raw = new Amqp091Raw(connect, await connect());
    await raw.openChannel(ADMIN);
    await raw.openChannel(MAIN);
    return raw;
  }

  /** The version the broker reports in its connection properties. */
  serverVersion(): string | null {
    const { version } = this.#connection(MAIN).model.connection
      .serverProperties as { version?: unknown };
    return typeof version === 'string' ? version : null;
  }

  /** Opens a connection beside `main`, so a scenario can make one client go away while another watches. */
  async openConnection(name: string): Promise<void> {
    if (this.#connections.has(name)) {
      throw new Error(`connection "${name}" is already used`);
    }
    this.#adopt(name, await this.#connect());
  }

  /**
   * Closes a connection gracefully (`connection.close`); its channels go with it, and a later settle
   * on one reports a closed channel. The default connection carries the lab's own channels and stays.
   */
  async closeConnection(name: string): Promise<void> {
    if (name === MAIN) {
      throw new Error('the main connection is never closed by a scenario');
    }
    const connection = this.#connection(name);
    // Marked first: the library's own 'close' events would otherwise name no reason.
    for (const state of this.#channels.values()) {
      if (state.connection === name) {
        state.closed ??= { code: null, text: 'closed with its connection' };
      }
    }
    await connection.model.close();
    connection.open = false;
  }

  async openChannel(name: string, connection = MAIN): Promise<void> {
    if (this.#channels.has(name)) {
      throw new Error(`channel "${name}" is already open`);
    }
    const channel = await this.#connection(connection).model.createChannel();
    const state: ChannelState = { channel, connection, prefetch: 0 };
    channel.on('error', (error: Error) => {
      state.closed = closeInfo(error);
    });
    channel.on('close', () => {
      state.closed ??= { code: null, text: 'closed' };
    });
    this.#channels.set(name, state);
  }

  async closeChannel(name: string): Promise<void> {
    const { channel } = this.#state(name);
    await channel.close();
    this.#state(name).closed ??= { code: null, text: 'closed by the client' };
  }

  async declareQueue(
    queue: string,
    options: {
      readonly type: QueueType;
      readonly durable: boolean;
      readonly arguments: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await this.#run(ADMIN, (channel) =>
      channel.assertQueue(queue, {
        durable: options.durable,
        exclusive: false,
        autoDelete: false,
        arguments: { ...options.arguments, 'x-queue-type': options.type },
      }),
    );
  }

  async deleteQueue(queue: string): Promise<void> {
    await this.#run(ADMIN, (channel) => channel.deleteQueue(queue));
  }

  async declareExchange(
    exchange: string,
    kind: 'direct' | 'fanout',
  ): Promise<void> {
    await this.#run(ADMIN, (channel) =>
      channel.assertExchange(exchange, kind, {
        durable: true,
        autoDelete: false,
      }),
    );
  }

  async deleteExchange(exchange: string): Promise<void> {
    await this.#run(ADMIN, (channel) => channel.deleteExchange(exchange));
  }

  /** Binds a queue to an exchange; a `fanout` ignores the key. */
  async bindQueue(queue: string, exchange: string, key: string): Promise<void> {
    await this.#run(ADMIN, (channel) =>
      channel.bindQueue(queue, exchange, key),
    );
  }

  /**
   * Publishes to the default exchange on a confirm channel and waits for the broker's confirm. The
   * one header a message may carry is a copied `x-delivery-count` (a scenario constant).
   */
  async publish(
    queue: string,
    message: {
      readonly messageId: string;
      readonly body: Buffer;
      readonly headers?: { readonly 'x-delivery-count'?: number };
    },
  ): Promise<void> {
    let state = this.#channels.get(PUBLISHER);
    if (state === undefined) {
      const channel = await this.#connection(MAIN).model.createConfirmChannel();
      channel.on('error', () => undefined);
      state = { channel, connection: MAIN, prefetch: 0 };
      this.#channels.set(PUBLISHER, state);
    }
    const channel = state.channel as ConfirmChannel;
    await new Promise<void>((resolve, reject) => {
      channel.sendToQueue(
        queue,
        message.body,
        {
          messageId: message.messageId,
          ...(message.headers === undefined
            ? {}
            : { headers: { ...message.headers } }),
        },
        (error: unknown) => {
          if (error) {
            reject(
              error instanceof Error
                ? error
                : new Error('the broker did not confirm the publish'),
            );
          } else {
            resolve();
          }
        },
      );
    });
  }

  /** `basic.get`; `null` when the queue is empty. */
  async get(
    channelName: string,
    queue: string,
    noAck: boolean,
  ): Promise<RawDelivery | null> {
    const message = await this.#run(channelName, (channel) =>
      channel.get(queue, { noAck }),
    );
    return message === false ? null : toDelivery(message);
  }

  /** Messages ready in the queue, from a passive declare on the admin channel (the broker answers at once). */
  async readyCount(queue: string): Promise<number> {
    const { messageCount } = await this.#run(ADMIN, (channel) =>
      channel.checkQueue(queue),
    );
    return messageCount;
  }

  /**
   * Consumes with manual acknowledgement until `count` deliveries arrived, then cancels. With
   * `cancel` false no `basic.cancel` is sent: the consumer stays active (and the unacknowledged
   * deliveries held) until its channel or connection closes.
   */
  async consume(
    channelName: string,
    queue: string,
    count: number,
    timeoutMs = 10_000,
    cancel = true,
  ): Promise<RawDelivery[]> {
    await this.#qos(channelName, count);
    const received: RawDelivery[] = [];
    let done: () => void = () => undefined;
    const enough = new Promise<void>((resolve) => {
      done = resolve;
    });
    const { consumerTag } = await this.#run(channelName, (channel) =>
      channel.consume(
        queue,
        (message) => {
          if (message === null) return;
          received.push(toDelivery(message));
          if (received.length >= count) done();
        },
        { noAck: false },
      ),
    );
    const timer = setTimeout(done, timeoutMs);
    try {
      await enough;
    } finally {
      clearTimeout(timer);
      if (cancel) {
        await this.#run(channelName, (channel) => channel.cancel(consumerTag));
      }
    }
    return received;
  }

  /**
   * Settles a delivery tag, which need not be one this channel was given. The library does not
   * track tags, so the broker decides; a round trip afterwards waits for the broker's answer.
   */
  async settle(
    channelName: string,
    tag: number,
    action: SettleAction,
  ): Promise<SettleOutcome> {
    const state = this.#state(channelName);
    const target = { fields: { deliveryTag: tag } } as unknown as Message;
    try {
      switch (action.kind) {
        case 'ack':
          state.channel.ack(target, action.multiple ?? false);
          break;
        case 'nack':
          state.channel.nack(target, action.multiple ?? false, action.requeue);
          break;
        case 'reject':
          state.channel.reject(target, action.requeue);
          break;
      }
      await state.channel.prefetch(state.prefetch);
    } catch (error) {
      state.closed ??= closeInfo(error);
    }
    return state.closed === undefined
      ? { channelOpen: true }
      : { channelOpen: false, closed: state.closed };
  }

  /** `basic.recover`: the broker requeues what the channel holds unacknowledged. */
  async recover(channelName: string): Promise<void> {
    await this.#run(channelName, (channel) => channel.recover());
  }

  /** Closes every connection still open, the ones a scenario opened first. */
  async close(): Promise<void> {
    const open = [...this.#connections.values()].filter((item) => item.open);
    for (const connection of open.reverse()) {
      connection.open = false;
      await connection.model.close().catch(() => undefined);
    }
  }

  #connection(name: string): ConnectionState {
    const connection = this.#connections.get(name);
    if (!connection?.open) {
      throw new Error(`connection "${name}" is not open`);
    }
    return connection;
  }

  /**
   * Runs one call on a channel. A channel the broker closes fails the call with "Channel ended",
   * and says why only in a separate event, so the failure is rethrown with the broker's own text.
   */
  async #run<T>(
    name: string,
    call: (channel: Channel) => Promise<T>,
  ): Promise<T> {
    const state = this.#state(name);
    try {
      return await call(state.channel);
    } catch (error) {
      await new Promise((resolve) => setImmediate(resolve));
      throw state.closed === undefined
        ? error
        : new Error(`channel "${name}" was closed: ${state.closed.text}`);
    }
  }

  async #qos(name: string, count: number): Promise<void> {
    await this.#run(name, (channel) => channel.prefetch(count));
    this.#state(name).prefetch = count;
  }

  #state(name: string): ChannelState {
    const state = this.#channels.get(name);
    if (state === undefined)
      throw new Error(`channel "${name}" was never opened`);
    return state;
  }
}
