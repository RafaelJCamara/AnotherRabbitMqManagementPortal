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

export interface RoleBudget {
  role: ConnectionRole;
  inUse: number;
  max: number;
  queued: number;
}

export interface ConnectionManager {
  peek(
    connectionId: ConnectionId,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<PeekLease>;
  source(
    connectionId: ConnectionId,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<SourceLease>;
  publish(
    connectionId: ConnectionId,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<PublishLease>;
  observe(
    connectionId: ConnectionId,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<ObserveLease>;
  /** Connections in use per role against the cap for the broker (A-10). */
  budget(connectionId: ConnectionId): RoleBudget[];
}
