// Management-plane HTTP ports (ADR-009, I-8). Reads and writes are separate ports, so a module that
// only reads cannot be handed a way to change the broker. Every request names a lane; the
// BrokerScheduler (@app/kernel) is the only code that runs them, so the adapters behind these ports
// are never called directly (I-8).
import type { ConnectionId } from '@app/contracts';
import type { z } from 'zod';

/** Scheduling lanes, highest priority first: interactive pre-empts live, which pre-empts background. */
export const LANES = ['interactive', 'live', 'background'] as const;
export type Lane = (typeof LANES)[number];

export type MgmtQuery = Readonly<Record<string, string | number | boolean>>;

export interface MgmtGetRequest<T> {
  connectionId: ConnectionId;
  path: string;
  query?: MgmtQuery;
  schema: z.ZodType<T>;
  lane: Lane;
}

export interface MgmtStreamRequest {
  connectionId: ConnectionId;
  path: string;
  query?: MgmtQuery;
  lane: Lane;
}

export interface MgmtSendRequest<T> {
  connectionId: ConnectionId;
  method: 'PUT' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  schema: z.ZodType<T>;
}

/** GET requests to the management API. Never changes the broker. */
export interface MgmtReadPort {
  get<T>(request: MgmtGetRequest<T>, signal: AbortSignal): Promise<T>;
  /** A large body as chunks (for example a definitions export). */
  stream(
    request: MgmtStreamRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
}

/** PUT, POST and DELETE requests to the management API. Reachable only from `implementAction` (I-2). */
export interface MgmtWritePort {
  send<T>(request: MgmtSendRequest<T>, signal: AbortSignal): Promise<T>;
}

export interface PromScrapeRequest {
  connectionId: ConnectionId;
  /** The broker node whose listener is scraped; nodes are scraped directly, never through a balancer. */
  node: string;
  path: `/${string}`;
  query?: MgmtQuery;
  lane: Lane;
}

/** Prometheus text exposition of one node, as chunks (large bodies go to a streaming parser). */
export interface PromScrapePort {
  scrape(
    request: PromScrapeRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
}
