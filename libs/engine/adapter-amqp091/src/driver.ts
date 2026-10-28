// The narrow surface of the AMQP 0-9-1 client library that this adapter uses, and the one place the
// library is imported (amqplib is confined to this project, I-11; `@types/amqplib` is banned, the
// library's own types are used). Everything else in the adapter talks to these interfaces, so the
// unit tests drive the leases with a scripted fake and the dual-library contract suite (M0-28) can
// put a second library behind the same seam.
//
// Nothing in this file opens a socket: amqplib is told to connect to the path of a Dialer forwarder
// (see connect.ts), and `connect()` below is only reached with that path.
import {
  connect as amqplibConnect,
  credentials as amqplibCredentials,
  type ChannelModel,
} from 'amqplib';

/** amqplib's own model type; the specs check that the seam below matches it where it matters. */
export type AmqplibModel = ChannelModel;

/** The fields of a delivery, get-ok or return that the adapter reads. */
export interface AmqpMessage {
  readonly content: Buffer;
  readonly fields: {
    readonly deliveryTag: number;
    readonly redelivered: boolean;
    readonly exchange: string;
    readonly routingKey: string;
    readonly consumerTag?: string;
    readonly replyCode?: number;
    readonly replyText?: string;
  };
  readonly properties: Readonly<Record<string, unknown>>;
}

/** What `ack` and `nack` read from a message: the delivery tag only. */
export interface AmqpSettleTarget {
  readonly fields: { readonly deliveryTag: number };
}

export interface AmqpChannel {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'return', listener: (message: AmqpMessage) => void): unknown;
  get(queue: string, options: { noAck: boolean }): Promise<AmqpMessage | false>;
  ack(message: AmqpSettleTarget, allUpTo?: boolean): void;
  nack(message: AmqpSettleTarget, allUpTo?: boolean, requeue?: boolean): void;
  prefetch(count: number, global?: boolean): Promise<unknown>;
  consume(
    queue: string,
    onMessage: (message: AmqpMessage | null) => void,
    options: { noAck: boolean },
  ): Promise<{ consumerTag: string }>;
  cancel(consumerTag: string): Promise<unknown>;
  checkQueue(
    queue: string,
  ): Promise<{ messageCount: number; consumerCount: number }>;
  checkExchange(exchange: string): Promise<unknown>;
  assertQueue(queue: string, options: AmqpQueueOptions): Promise<unknown>;
  bindQueue(
    queue: string,
    source: string,
    pattern: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  unbindQueue(
    queue: string,
    source: string,
    pattern: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  /** On a confirm channel the callback reports the broker's ack (`null`) or nack (an error). */
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Record<string, unknown>,
    callback: (error: unknown) => void,
  ): boolean;
  close(): Promise<void>;
}

export interface AmqpQueueOptions {
  readonly exclusive: boolean;
  readonly durable: boolean;
  readonly autoDelete: boolean;
  readonly arguments: Record<string, unknown>;
}

export interface AmqpModel {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (error?: Error) => void): unknown;
  on(event: 'blocked', listener: (reason: string) => void): unknown;
  on(event: 'unblocked', listener: () => void): unknown;
  createChannel(): Promise<AmqpChannel>;
  createConfirmChannel(): Promise<AmqpChannel>;
  close(): Promise<void>;
  /**
   * `connection.update-secret`. amqplib 2.2.0 wants the secret as a `Buffer` (a string throws) and
   * settles only on the broker's `update-secret-ok`: a broker that refuses the secret closes the
   * connection instead, and the promise then never settles. The caller bounds it and listens for
   * the close (connect.ts).
   */
  updateSecret(secret: Buffer, reason: string): Promise<void>;
  readonly connection: {
    readonly serverProperties?: Readonly<Record<string, unknown>>;
  };
}

/** The login mechanism handed to the library. Built by the driver; the adapter never reads it. */
export interface AmqpLogin {
  readonly mechanism: string;
  response(): Buffer;
}

/** What the adapter passes to `connect`: only a path, never a host to dial (see connect.ts). */
export interface AmqpConnectTarget {
  readonly protocol: 'amqp' | 'amqps';
  /** A documentation-range address that is never dialled because `path` is set. */
  readonly hostname: string;
  readonly port: number;
  readonly vhost: string;
  readonly heartbeat: number;
}

export interface AmqpSocketOptions {
  /** The Unix socket or named pipe of the Dialer's forwarder. */
  readonly path: string;
  readonly timeout: number;
  readonly noDelay: boolean;
  readonly clientProperties: Readonly<Record<string, unknown>>;
  readonly credentials: AmqpLogin;
  /** Present for `amqps`: the TrustStore's options for the TLS handshake (secureContext, ...). */
  readonly tls?: Readonly<Record<string, unknown>>;
}

export interface Amqp091Driver {
  connect(
    target: AmqpConnectTarget,
    options: AmqpSocketOptions,
  ): Promise<AmqpModel>;
  plain(username: string, password: string): AmqpLogin;
  external(): AmqpLogin;
}

/** The driver on amqplib 2.2.0. */
export const amqplibDriver: Amqp091Driver = {
  async connect(target, options) {
    const { tls, ...socket } = options;
    // `path` makes `net.connect` / `tls.connect` open the forwarder pipe and ignore host and port;
    // the target's host is a documentation address in case a future library version did not.
    const model = await amqplibConnect(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        vhost: target.vhost,
        heartbeat: target.heartbeat,
      },
      { ...tls, ...socket },
    );
    return model as unknown as AmqpModel;
  },
  plain: (username, password) => amqplibCredentials.plain(username, password),
  external: () => amqplibCredentials.external(),
};
