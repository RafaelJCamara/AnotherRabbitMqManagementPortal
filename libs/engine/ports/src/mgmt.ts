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

/** A query where a key may repeat: a list is sent as one pair per item (`family=a&family=b`). */
export type PromQuery = Readonly<
  Record<string, string | number | boolean | readonly string[]>
>;

export interface PromScrapeRequest {
  connectionId: ConnectionId;
  /** The broker node whose listener is scraped; nodes are scraped directly, never through a balancer. */
  node: string;
  /**
   * The listener, as a URL of the BrokerProfile's `prometheus.endpoints`, when a node name alone is
   * not enough (Amazon MQ lists three listeners under one name). The resolver refuses a URL the
   * profile does not list, so a request cannot name an address the engine never probed.
   */
  endpoint?: string;
  path: `/${string}`;
  query?: PromQuery;
  lane: Lane;
}

/** Prometheus text exposition of one node, as chunks (large bodies go to a streaming parser). */
export interface PromScrapePort {
  scrape(
    request: PromScrapeRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
}

/** One sample of a Prometheus text exposition. */
export interface PromSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
  /** Milliseconds since the epoch, when the exposition gave one. */
  readonly timestamp?: number;
}

export interface PromReadOptions {
  /** Keeps a family; asked with the metric name before its labels are read. Default: all. */
  readonly wanted?: (name: string) => boolean;
  /**
   * Keeps a parsed sample, asked after its labels are read. A refused sample is counted as skipped
   * and does not count toward maxSamples.
   */
  readonly accept?: (sample: PromSample) => boolean;
  /** The most samples delivered; at the limit the read stops and the summary says so. */
  readonly maxSamples?: number;
  /** The most bytes taken from the body; a bigger one fails the read. */
  readonly maxBodyBytes?: number;
}

export interface PromReadSummary {
  readonly bytes: number;
  /** Samples handed to the sink. */
  readonly samples: number;
  /** Sample lines of a family nobody wanted. */
  readonly skipped: number;
  /** Lines that are not valid exposition, dropped. */
  readonly malformed: number;
  /** Lines over the line limit, dropped. */
  readonly oversizedLines: number;
  readonly truncated?: 'samples';
}

/**
 * A scrape read to samples (blueprint 1.4: the body is parsed as a stream, never held). It is
 * built over a PromScrapePort, so the BrokerScheduler's wrapper sits underneath and a service
 * never sees the adapter or a chunk; sink is called for each wanted sample in body order. The
 * promise rejects with the error of the scrape or of the parse.
 */
export interface PromReadPort {
  read(
    request: PromScrapeRequest,
    sink: (sample: PromSample) => void,
    options: PromReadOptions,
    signal: AbortSignal,
  ): Promise<PromReadSummary>;
}
