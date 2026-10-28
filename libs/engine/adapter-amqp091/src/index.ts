// @app/adapter-amqp091: AMQP 0-9-1 behind the role-typed lease ports (M0-27, ADR-009, ADR-012).
// amqplib is imported by `driver.ts` only; nothing here hands out a channel.
export {
  connectControl,
  connectObserve,
  connectPeek,
  connectPublish,
  connectSource,
  formatConnectionName,
  parseConnectionName,
  type Amqp091Credentials,
  type Amqp091CredentialsSource,
  type Amqp091Endpoint,
  type ConnectionInfo,
  type ConnectionListener,
  type ConnectionNameParts,
  type ConnectOptions,
  type OpenedLease,
} from './connect.ts';
export type { ConnectionEvent } from './channel.ts';
export type {
  Amqp091Driver,
  AmqpChannel,
  AmqpConnectTarget,
  AmqpLogin,
  AmqpMessage,
  AmqpModel,
  AmqpQueueOptions,
  AmqpSettleTarget,
  AmqpSocketOptions,
} from './driver.ts';
export { amqplibDriver } from './driver.ts';
export {
  Amqp091Error,
  mapAmqplibError,
  type Amqp091ErrorCode,
  type Amqp091ErrorOptions,
  type Amqp091Reason,
  type BrokerClose,
} from './errors.ts';
export {
  fromTypedHeaders,
  MAX_HEADER_DEPTH,
  toTypedHeaders,
} from './headers.ts';
export type { BlockedSnapshot } from './blocked.ts';
export type { ControlLease } from './leases/control.ts';
export type { PeekLeaseOptions, QueueTypeLookup } from './leases/peek.ts';
