// The seam through which the ConnectionManager opens AMQP 0-9-1 connections (M0-43). The adapter
// (`adapter-amqp091`) implements it at the composition root: it resolves the connection id to the
// profile's endpoint, credentials, TLS trust and route, and calls `connectPeek` and the others. A
// service never imports the adapter, so the manager sees only this shape (blueprint 2.2, I-9).
import type { ConnectionId } from '@app/contracts';

import type {
  ObserveLease,
  PeekLease,
  PublishLease,
  SourceLease,
} from './amqp091.ts';

/** What the manager asks for. Everything else about the target is the connector's business. */
export interface ConnectorRequest {
  connectionId: ConnectionId;
  vhost: string;
  /** The `connection_name` parts: `<product>/<mode>/<role>/<session>` (blueprint 5.3). */
  name: { product: string; mode: string; session: string };
}

/** A connection event the manager cares about. The adapter's events are assignable to it. */
export interface ConnectorEvent {
  type: string;
  /**
   * On a `closed` event the broker closed the connection with this reply code: 320 means the
   * connection was forced (4.2.6 and later close this way when a token runs out), 530 that it
   * refused a renewed secret. Absent when the client closed it or the socket dropped.
   */
  code?: number | string;
}

/** A lease and the connection behind it. `subscribe` reports `closed` when the connection ends. */
export interface OpenedConnection<L> {
  lease: L;
  info: { connectionName: string };
  subscribe(listener: (event: ConnectorEvent) => void): () => void;
  /**
   * Hands the broker a renewed secret on this connection (AMQP 0-9-1 `connection.update-secret`).
   * Resolves when the broker acknowledges it; rejects when it refuses or the connection ends. The
   * secret is not kept and appears in no error. Absent when the connector cannot renew.
   */
  renew?(secret: string, reason: string): Promise<void>;
}

/** One open per role: one connection serves one role and hands out that role's lease. */
export interface Amqp091Connector {
  openPeek(
    request: ConnectorRequest,
    signal: AbortSignal,
  ): Promise<OpenedConnection<PeekLease>>;
  openSource(
    request: ConnectorRequest,
    signal: AbortSignal,
  ): Promise<OpenedConnection<SourceLease>>;
  openPublish(
    request: ConnectorRequest,
    signal: AbortSignal,
  ): Promise<OpenedConnection<PublishLease>>;
  openObserve(
    request: ConnectorRequest,
    signal: AbortSignal,
  ): Promise<OpenedConnection<ObserveLease>>;
}
