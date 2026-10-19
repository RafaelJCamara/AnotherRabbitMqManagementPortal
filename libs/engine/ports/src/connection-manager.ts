// The ConnectionManager hands out role-typed leases (ADR-009, A-10). Each broker has five roles;
// a lease exposes only the methods of the role it was taken for.
import type { ConnectionId } from '@app/contracts';

import type {
  ObserveLease,
  PeekLease,
  PublishLease,
  SourceLease,
} from './amqp091.ts';

/** Who is acting. The ActionExecutor (kernel) builds it; ports only carry it. */
export interface Principal {
  kind:
    | 'desktop-user'
    | 'local-token'
    | 'team-user'
    | 'api-token'
    | 'mcp-client'
    | 'job'
    | 'system';
  id: string;
  display: string;
  roles: string[];
  surface: 'ui' | 'cli' | 'mcp' | 'job' | 'system';
  unattended: boolean;
  onBehalfOf?: Principal;
}

export type ConnectionRole =
  | 'control'
  | 'peek'
  | 'source'
  | 'publish'
  | 'observe';

/** The tool's own connections of one role on one vhost against the cap for them (A-10). */
export interface RoleBudget {
  role: ConnectionRole;
  /** Budgets are keyed by (connection, vhost, role): AMQP connections belong to one vhost. */
  vhost: string;
  inUse: number;
  max: number;
  queued: number;
  /**
   * Milliseconds until the next queued request can be served, an estimate from how long leases of
   * this role were held so far. `null` when nothing is queued.
   */
  etaMs: number | null;
}

/** "The tool uses `inUse` of `max` connections" of one broker, across vhosts and roles (A-10). */
export interface ConnectionUsage {
  inUse: number;
  max: number;
  queued: number;
  /** The broker's own `connection_max`, when it is known (probe or provider preset). */
  brokerMax: number | null;
}

/**
 * Role-typed leases. Every lease names the vhost, because a connection is per vhost and team pools
 * are keyed by (user, broker, vhost, protocol, role). A call waits when the budget is spent and
 * fails with `RATE_LIMITED` (429, with an ETA in its detail) when the queue is full or the wait
 * runs out.
 */
export interface ConnectionManager {
  peek(
    connectionId: ConnectionId,
    vhost: string,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<PeekLease>;
  source(
    connectionId: ConnectionId,
    vhost: string,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<SourceLease>;
  publish(
    connectionId: ConnectionId,
    vhost: string,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<PublishLease>;
  observe(
    connectionId: ConnectionId,
    vhost: string,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<ObserveLease>;
  /** Connections in use per role against the cap for the broker and vhost (A-10). */
  budget(connectionId: ConnectionId, vhost: string): RoleBudget[];
  /** Connections in use on the whole broker against the tool's cap (A-10). */
  usage(connectionId: ConnectionId): ConnectionUsage;
}
