// EngineTransport: how the UI reaches the engine (blueprint 10, ADR-002, ADR-005). Two carriers
// implement it, the desktop MessagePort tunnel and HTTP plus WebSocket; the rest of the UI codes
// against this interface only. One transport serves both the REST router (`request`) and the one
// live session of the UI (`openLive`).
import { InjectionToken } from '@angular/core';
import type { ClientFrame, ServerFrame } from '@app/contracts';

export type TransportBody = string | ArrayBuffer;

/** instanceof fails for a buffer from another realm (an iframe, a structured clone in a test). */
export const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  Object.prototype.toString.call(value) === '[object ArrayBuffer]';

export interface TransportRequest {
  readonly method: string;
  /** Path and query below the origin, for example `/api/v1/meta`. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: TransportBody;
}

export interface TransportResponse {
  readonly status: number;
  /** Header names are lower case. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: TransportBody;
}

/**
 * The live session on one carrier. `frames()` yields the server frames in order and completes when
 * the carrier is lost or `close()` is called; it throws a TransportError when the carrier breaks
 * the protocol. It can be iterated once.
 */
export interface LiveChannel {
  /** Throws a TransportError when the channel is closed. */
  send(frame: ClientFrame): void;
  frames(): AsyncIterable<ServerFrame>;
  close(): void;
}

export interface EngineTransport {
  readonly kind: 'messageport' | 'http';
  request(
    request: TransportRequest,
    signal?: AbortSignal,
  ): Promise<TransportResponse>;
  openLive(): LiveChannel;
}

export const ENGINE_TRANSPORT = new InjectionToken<EngineTransport>(
  'ENGINE_TRANSPORT',
);

export type TransportErrorReason =
  /** The caller aborted the request. */
  | 'aborted'
  /** The carrier is closed or went away. */
  | 'closed'
  /** The request could not reach the engine. */
  | 'network'
  /** The engine sent something the protocol does not allow. */
  | 'protocol'
  /** A bounded buffer is full: the response, the frame queue or the send queue. */
  | 'overflow';

/** Why the carrier failed, never an engine answer: engine errors are Problems. */
export class TransportError extends Error {
  readonly reason: TransportErrorReason;

  constructor(reason: TransportErrorReason, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TransportError';
    this.reason = reason;
  }
}

export const isTransportError = (value: unknown): value is TransportError =>
  value instanceof TransportError;

/** Bounds shared by both carriers (I-6 applies to the UI buffers too). */
export const DEFAULT_MAX_PENDING_FRAMES = 4096;
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
