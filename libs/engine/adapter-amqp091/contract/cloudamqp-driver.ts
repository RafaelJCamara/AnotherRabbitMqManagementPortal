// The second AMQP 0-9-1 client behind the adapter's seam (M0-28, DC-48): `@cloudamqp/amqp-client`
// 4.1.1 wrapped as an `Amqp091Driver`. Test-only: nothing under `src/` imports this file, and the
// package is a dev dependency, so it is never bundled (I-11 allows it in this project only).
//
// The adapter was written against amqplib's shapes (callbacks, `fields`/`properties`, events,
// error objects that carry the broker's reply code), so this shim translates them in both
// directions and nothing else: it adds no behaviour of its own. Where the two libraries cannot
// agree it says so (the differences below), and the contract suite asserts only what both can do.
//
// Known differences, all recorded in docs/open-questions.md (OQ-260):
//  - SASL EXTERNAL does not exist in 4.1.1 (PLAIN only). `external()` still returns a login so the
//    adapter can build it; `connect` then refuses it. The suite records this as an expected skip.
//  - Integer header widths: a `byte`, `short` or `int` is written as an int32 and a `long` as an
//    int64; a `double` is written as a float32 unless it is integral. Reading is exact.
//  - Decimal headers cannot be written.
//  - `connection.serverProperties` is not kept, so `ConnectionInfo.serverVersion` is `undefined`.
import {
  AMQPClient,
  type AMQPChannel as CloudChannel,
  type AMQPMessage as CloudMessage,
  type AMQPProperties as CloudProperties,
  type Field as CloudField,
} from '@cloudamqp/amqp-client';

import type {
  Amqp091Driver,
  AmqpChannel,
  AmqpConnectTarget,
  AmqpLogin,
  AmqpMessage,
  AmqpQueueOptions,
  AmqpSettleTarget,
  AmqpSocketOptions,
} from '../src/driver.ts';

// ---------------------------------------------------------------------------------------------
// Errors: the shapes `mapAmqplibError` reads (message prefix, numeric `code`)
// ---------------------------------------------------------------------------------------------

const REPLY_NAMES: Readonly<Record<number, string>> = {
  311: 'CONTENT-TOO-LARGE',
  312: 'NO-ROUTE',
  313: 'NO-CONSUMERS',
  320: 'CONNECTION-FORCED',
  402: 'INVALID-PATH',
  403: 'ACCESS-REFUSED',
  404: 'NOT-FOUND',
  405: 'RESOURCE-LOCKED',
  406: 'PRECONDITION-FAILED',
  501: 'FRAME-ERROR',
  502: 'SYNTAX-ERROR',
  503: 'COMMAND-INVALID',
  504: 'CHANNEL-ERROR',
  505: 'UNEXPECTED-FRAME',
  506: 'RESOURCE-ERROR',
  530: 'NOT-ALLOWED',
  540: 'NOT-IMPLEMENTED',
  541: 'INTERNAL-ERROR',
};

/** `channel 3 closed: NOT_FOUND - no queue 'q' in vhost '/' (404)` and the connection form. */
const CLOSE_FRAME = /^(channel \d+|connection) closed: ([\s\S]*) \((\d{3})\)$/;

function replyError(
  prefix: string,
  code: number,
  text: string,
): Error & { code: number } {
  const name = REPLY_NAMES[code] ?? 'UNKNOWN';
  return Object.assign(
    new Error(`${prefix}: ${String(code)} (${name}) with message "${text}"`),
    { code },
  );
}

/**
 * What amqplib would have thrown for the same event: a broker close keeps its reply code, a closed
 * channel is an `IllegalOperationError`, anything else passes through unchanged.
 */
export function translateError(
  error: unknown,
  phase: 'handshake' | 'open' = 'open',
): unknown {
  if (!(error instanceof Error)) return error;
  const frame = CLOSE_FRAME.exec(error.message);
  if (frame?.[2] !== undefined && frame[3] !== undefined) {
    const code = Number(frame[3]);
    const isChannel = frame[1] !== 'connection';
    if (!isChannel && phase === 'handshake') {
      return replyError('Handshake terminated by server', code, frame[2]);
    }
    return replyError(
      isChannel ? 'Channel closed by server' : 'Connection closed',
      code,
      frame[2],
    );
  }
  if (
    /^(Channel is closed|Connection closed|Connection closed by client)$/.test(
      error.message,
    )
  ) {
    return Object.assign(new Error('Channel closed'), {
      name: 'IllegalOperationError',
    });
  }
  return error;
}

// ---------------------------------------------------------------------------------------------
// Values: amqplib's notation <-> @cloudamqp/amqp-client's
// ---------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** `{'!': type, value}`, the form the adapter uses to ask amqplib for an exact AMQP type. */
function isTagged(
  value: unknown,
): value is { '!': string; value: unknown } & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value['!'] === 'string' &&
    Object.keys(value).length === 2 &&
    'value' in value
  );
}

function toLibraryField(value: unknown): CloudField {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map(toLibraryField);
  }
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (isTagged(value)) {
    const inner = value.value;
    switch (value['!']) {
      case 'long':
        // A bigint is the one value this library writes as an int64 whatever its size.
        return typeof inner === 'number' ? BigInt(inner) : (inner as bigint);
      case 'byte':
      case 'short':
      case 'int':
      case 'double':
      case 'float':
        return inner as number;
      case 'timestamp':
        return new Date(Number(inner) * 1000);
      default:
        throw new Error(`@cloudamqp/amqp-client cannot write a ${value['!']}`);
    }
  }
  return toLibraryTable(value as Record<string, unknown>);
}

export function toLibraryTable(
  table: Record<string, unknown>,
): Record<string, CloudField> {
  const out: Record<string, CloudField> = {};
  for (const key of Object.keys(table)) out[key] = toLibraryField(table[key]);
  return out;
}

function fromLibraryField(value: unknown): unknown {
  if (value instanceof Date) {
    return { '!': 'timestamp', value: Math.floor(value.getTime() / 1000) };
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return (value as unknown[]).map(fromLibraryField);
  if (isRecord(value)) return fromLibraryTable(value);
  return value;
}

export function fromLibraryTable(
  table: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(table)) out[key] = fromLibraryField(table[key]);
  return out;
}

/** The basic properties as amqplib reports them: a timestamp in seconds, headers converted. */
export function fromLibraryProperties(
  properties: CloudProperties,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key === 'timestamp' && value instanceof Date) {
      out[key] = Math.floor(value.getTime() / 1000);
    } else if (key === 'headers' && isRecord(value)) {
      out[key] = fromLibraryTable(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const PUBLISH_PROPERTIES = [
  'contentType',
  'contentEncoding',
  'deliveryMode',
  'priority',
  'correlationId',
  'replyTo',
  'expiration',
  'messageId',
  'type',
  'userId',
  'appId',
] as const;

/** amqplib publish options to this library's properties; `mandatory` is not a property. */
export function toLibraryProperties(
  options: Record<string, unknown>,
): CloudProperties {
  const out: Record<string, unknown> = {};
  for (const key of PUBLISH_PROPERTIES) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  if (typeof options.timestamp === 'number') {
    out.timestamp = new Date(options.timestamp * 1000);
  }
  if (isRecord(options.headers)) {
    out.headers = toLibraryTable(options.headers);
  }
  return out;
}

function toAmqpMessage(message: CloudMessage): AmqpMessage {
  return {
    content: Buffer.from(message.body ?? new Uint8Array(0)),
    fields: {
      deliveryTag: message.deliveryTag,
      redelivered: message.redelivered,
      exchange: message.exchange,
      routingKey: message.routingKey,
      ...(message.consumerTag === ''
        ? {}
        : { consumerTag: message.consumerTag }),
      ...(message.replyCode === undefined
        ? {}
        : { replyCode: message.replyCode }),
      ...(message.replyText === undefined
        ? {}
        : { replyText: message.replyText }),
    },
    properties: fromLibraryProperties(message.properties),
  };
}

// ---------------------------------------------------------------------------------------------
// A minimal event emitter: a missing 'error' listener must not throw
// ---------------------------------------------------------------------------------------------

type Listener = (...args: never[]) => void;

class Emitter {
  readonly #listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const set = this.#listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(event, set);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      (listener as (...rest: unknown[]) => void)(...args);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------------------------

async function translated<T>(run: Promise<T>): Promise<T> {
  try {
    return await run;
  } catch (error) {
    throw translateError(error);
  }
}

function closedChannel(): Error {
  return Object.assign(new Error('Channel closed'), {
    name: 'IllegalOperationError',
  });
}

function wrapChannel(channel: CloudChannel): AmqpChannel {
  const events = new Emitter();
  // A server-closed channel (and a lost socket) end in `onerror`; a client close does not.
  channel.onerror = (reason: string) => {
    if (/^channel \d+ closed:/.test(reason)) {
      events.emit('error', translateError(new Error(reason)));
    }
    events.emit('close');
  };
  channel.onReturn = (message: CloudMessage) => {
    events.emit('return', toAmqpMessage(message));
  };

  const wrapper = {
    on(event: string, listener: Listener) {
      events.on(event, listener);
      return wrapper;
    },
    async get(queue: string, options: { noAck: boolean }) {
      const message = await translated(
        channel.basicGet(queue, { noAck: options.noAck }),
      );
      return message === null ? (false as const) : toAmqpMessage(message);
    },
    ack(message: AmqpSettleTarget, allUpTo = false) {
      if (channel.closed) throw closedChannel();
      void channel
        .basicAck(message.fields.deliveryTag, allUpTo)
        .catch(() => undefined);
    },
    nack(message: AmqpSettleTarget, allUpTo = false, requeue = true) {
      if (channel.closed) throw closedChannel();
      void channel
        .basicNack(message.fields.deliveryTag, requeue, allUpTo)
        .catch(() => undefined);
    },
    prefetch: (count: number, global = false) =>
      translated(channel.basicQos(count, 0, global)),
    async consume(
      queue: string,
      onMessage: (message: AmqpMessage | null) => void,
      options: { noAck: boolean },
    ) {
      const consumer = await translated(
        channel.basicConsume(queue, { noAck: options.noAck }, (message) => {
          onMessage(toAmqpMessage(message));
        }),
      );
      // The library has no 'cancelled' callback. It closes the consumer with an error when the
      // server cancels it; the same error with the channel closed too means the channel went.
      consumer.wait().catch(() => {
        if (!channel.closed) onMessage(null);
      });
      return { consumerTag: consumer.tag };
    },
    cancel: (consumerTag: string) =>
      translated(channel.basicCancel(consumerTag)),
    async checkQueue(queue: string) {
      const ok = await translated(
        channel.queueDeclare(queue, { passive: true }),
      );
      return { messageCount: ok.messageCount, consumerCount: ok.consumerCount };
    },
    checkExchange: (exchange: string) =>
      translated(
        channel.exchangeDeclare(exchange, 'direct', { passive: true }),
      ),
    assertQueue: (queue: string, options: AmqpQueueOptions) =>
      translated(
        channel.queueDeclare(
          queue,
          {
            durable: options.durable,
            exclusive: options.exclusive,
            autoDelete: options.autoDelete,
          },
          toLibraryTable(options.arguments),
        ),
      ),
    bindQueue: (
      queue: string,
      source: string,
      pattern: string,
      args: Record<string, unknown>,
    ) =>
      translated(
        channel.queueBind(queue, source, pattern, toLibraryTable(args)),
      ),
    unbindQueue: (
      queue: string,
      source: string,
      pattern: string,
      args: Record<string, unknown>,
    ) =>
      translated(
        channel.queueUnbind(queue, source, pattern, toLibraryTable(args)),
      ),
    publish(
      exchange: string,
      routingKey: string,
      content: Buffer,
      options: Record<string, unknown>,
      callback: (error: unknown) => void,
    ) {
      channel
        .basicPublish(
          exchange,
          routingKey,
          content,
          toLibraryProperties(options),
          options.mandatory === true,
        )
        .then(
          () => {
            callback(null);
          },
          (error: unknown) => {
            // amqplib reports a negative confirm as this error; the adapter matches the text.
            callback(
              error instanceof Error && error.message === 'Message rejected'
                ? new Error('message nacked')
                : translateError(error),
            );
          },
        );
      return true;
    },
    async close() {
      await translated(channel.close());
      events.emit('close');
    },
  };
  return wrapper;
}

// ---------------------------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------------------------

function credentialsOf(login: AmqpLogin): { user: string; password: string } {
  // PLAIN is `\0user\0password` (RFC 4616); the library builds the same string from the URL.
  const [, user = '', password = ''] = login
    .response()
    .toString('utf8')
    .split('\0');
  return { user, password };
}

function connectionUrl(
  target: AmqpConnectTarget,
  options: AmqpSocketOptions,
): string {
  const { user, password } = credentialsOf(options.credentials);
  const name = options.clientProperties.connection_name;
  const query = new URLSearchParams({ heartbeat: String(target.heartbeat) });
  if (typeof name === 'string') query.set('name', name);
  return `${target.protocol}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${target.hostname}:${String(target.port)}/${target.vhost}?${query.toString()}`;
}

export const cloudamqpDriver: Amqp091Driver = {
  async connect(target, options) {
    if (options.credentials.mechanism !== 'PLAIN') {
      throw new Error(
        `@cloudamqp/amqp-client 4.1.1 offers PLAIN only, not ${options.credentials.mechanism}`,
      );
    }
    // The library spreads its TLS options into `net.connect` / `tls.connect`, so `path` (the
    // Dialer's forwarder) reaches the socket and the host in the URL is never dialled.
    const client = new AMQPClient(connectionUrl(target, options), {
      ...options.tls,
      path: options.path,
    } as never);
    const events = new Emitter();
    client.onerror = (error) => {
      events.emit('error', translateError(error));
    };
    client.ondisconnect = (error) => {
      events.emit(
        'close',
        error === undefined ? undefined : translateError(error),
      );
    };
    client.onblocked = (reason) => {
      events.emit('blocked', reason);
    };
    client.onunblocked = () => {
      events.emit('unblocked');
    };
    try {
      await client.connect();
    } catch (error) {
      throw translateError(error, 'handshake');
    }
    client.socket?.setNoDelay(options.noDelay);

    const model = {
      on(event: string, listener: Listener) {
        events.on(event, listener);
        return model;
      },
      async createChannel() {
        return wrapChannel(await translated(client.channel()));
      },
      async createConfirmChannel() {
        const channel = await translated(client.channel());
        await translated(channel.confirmSelect());
        return wrapChannel(channel);
      },
      async close() {
        await translated(client.close());
        events.emit('close');
      },
      connection: {},
    };
    return model;
  },
  plain: (username, password): AmqpLogin => ({
    mechanism: 'PLAIN',
    response: () => Buffer.from(`\0${username}\0${password}`, 'utf8'),
  }),
  external: (): AmqpLogin => ({
    mechanism: 'EXTERNAL',
    response: () => Buffer.alloc(0),
  }),
};
