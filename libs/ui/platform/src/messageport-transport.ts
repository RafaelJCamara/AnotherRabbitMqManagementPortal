// The desktop carrier (ADR-002): the REST router is tunnelled through one MessagePort as `http.req`,
// `http.res` and `http.chunk` frames, and the live protocol rides the same port as `live` frames.
// Main issues exactly one port per page load; this class owns it. The desktop reconnect after an
// engine restart (a new port) is built with the desktop app in M2 (ADR-030).
import { isDevMode } from '@angular/core';
import {
  PortFrameSchema,
  type ClientFrame,
  type PortFrame,
  type ServerFrame,
} from '@app/contracts';

import {
  DEFAULT_MAX_PENDING_FRAMES,
  DEFAULT_MAX_RESPONSE_BYTES,
  TransportError,
  type EngineTransport,
  type LiveChannel,
  type TransportRequest,
  type TransportResponse,
} from './engine-transport';
import { FrameQueue } from './frame-queue';

export type EnginePort = Pick<
  MessagePort,
  'postMessage' | 'addEventListener' | 'removeEventListener' | 'start' | 'close'
>;

export interface MessagePortTransportOptions {
  /** Check every inbound frame against the contract. Defaults to dev and test builds. */
  readonly validate?: boolean;
  /** Largest streamed response body accepted before the request is aborted. */
  readonly maxResponseBytes?: number;
  /** Server frames that may wait for the LiveClient. */
  readonly maxPendingFrames?: number;
}

type HttpResFrame = Extract<PortFrame, { t: 'http.res' }>;

interface Pending {
  readonly resolve: (response: TransportResponse) => void;
  readonly reject: (error: unknown) => void;
  /** Set once an `http.res` with `streamed` arrived. */
  streamed?: { head: HttpResFrame; chunks: ArrayBuffer[]; bytes: number };
}

function concat(chunks: readonly ArrayBuffer[], bytes: number): ArrayBuffer {
  const out = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    out.set(new Uint8Array(chunk), at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

const abortError = (): TransportError =>
  new TransportError('aborted', 'The request was aborted.');

export class MessagePortTransport implements EngineTransport {
  readonly kind = 'messageport';
  readonly #port: EnginePort;
  readonly #validate: boolean;
  readonly #maxResponseBytes: number;
  readonly #maxPendingFrames: number;
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  #closed = false;
  #live: FrameQueue<ServerFrame> | null = null;

  constructor(port: EnginePort, options: MessagePortTransportOptions = {}) {
    this.#port = port;
    this.#validate = options.validate ?? isDevMode();
    this.#maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#maxPendingFrames =
      options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES;
    port.addEventListener('message', this.#onMessage);
    port.addEventListener('close', this.#onClose);
    port.start();
  }

  get closed(): boolean {
    return this.#closed;
  }

  request(
    request: TransportRequest,
    signal?: AbortSignal,
  ): Promise<TransportResponse> {
    if (this.#closed) {
      return Promise.reject(
        new TransportError('closed', 'The engine port is closed.'),
      );
    }
    if (signal?.aborted === true) return Promise.reject(abortError());
    const id = this.#nextId++;
    return new Promise<TransportResponse>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.#pending.delete(id)) {
          this.#post({ t: 'http.abort', id });
          reject(abortError());
        }
      };
      const settle = <T>(fn: (value: T) => void) => {
        return (value: T): void => {
          signal?.removeEventListener('abort', onAbort);
          fn(value);
        };
      };
      this.#pending.set(id, {
        resolve: settle(resolve),
        reject: settle(reject),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.#post({
          t: 'http.req',
          id,
          method: request.method,
          url: request.url,
          headers: { ...request.headers },
          ...(request.body === undefined ? {} : { body: request.body }),
        });
      } catch (error) {
        this.#pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(
          new TransportError(
            'network',
            'The request could not be sent.',
            error,
          ),
        );
      }
    });
  }

  openLive(): LiveChannel {
    this.#live?.end();
    const queue = new FrameQueue<ServerFrame>(this.#maxPendingFrames);
    if (this.#closed) queue.end();
    this.#live = queue;
    const closeChannel = (): void => {
      queue.end();
      if (this.#live === queue) this.#live = null;
    };
    return {
      send: (frame: ClientFrame): void => {
        if (this.#closed || queue.done) {
          throw new TransportError('closed', 'The live channel is closed.');
        }
        this.#post({ t: 'live', frame });
      },
      frames: () => queue,
      close: closeChannel,
    };
  }

  /** Stops using the port. Pending requests fail and the live channel ends. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#port.removeEventListener('message', this.#onMessage);
    this.#port.removeEventListener('close', this.#onClose);
    this.#port.close();
    this.#failAll(new TransportError('closed', 'The engine port is closed.'));
  }

  #post(frame: PortFrame): void {
    this.#port.postMessage(frame);
  }

  readonly #onClose = (): void => {
    this.#closed = true;
    this.#failAll(new TransportError('closed', 'The engine port closed.'));
  };

  #failAll(error: TransportError): void {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.reject(error);
    }
    this.#live?.end();
    this.#live = null;
  }

  readonly #onMessage = (event: Event): void => {
    const data = (event as MessageEvent<unknown>).data;
    let frame: PortFrame;
    if (this.#validate) {
      const parsed = PortFrameSchema.safeParse(data);
      if (!parsed.success) {
        this.#protocolError('invalid port frame');
        return;
      }
      frame = parsed.data;
    } else {
      if (typeof data !== 'object' || data === null || !('t' in data)) {
        this.#protocolError('invalid port frame');
        return;
      }
      frame = data as PortFrame;
    }
    switch (frame.t) {
      case 'http.res': {
        this.#onResponse(frame);
        return;
      }
      case 'http.chunk': {
        this.#onChunk(frame);
        return;
      }
      case 'live':
        // A client frame on the server's side of the port is a protocol error.
        if (!isServerFrame(frame.frame)) {
          this.#protocolError('client frame from the engine');
          return;
        }
        this.#live?.push(frame.frame);
        return;
      case 'http.req':
      case 'http.abort': {
        this.#protocolError(`${frame.t} from the engine`);
        return;
      }
    }
  };

  #onResponse(frame: HttpResFrame): void {
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) return;
    if (frame.streamed === true) {
      pending.streamed = { head: frame, chunks: [], bytes: 0 };
      return;
    }
    this.#pending.delete(frame.id);
    pending.resolve({
      status: frame.status,
      headers: lowerCase(frame.headers),
      ...(frame.body === undefined ? {} : { body: frame.body }),
    });
  }

  #onChunk(frame: Extract<PortFrame, { t: 'http.chunk' }>): void {
    const pending = this.#pending.get(frame.id);
    const streamed = pending?.streamed;
    if (pending === undefined || streamed === undefined) return;
    streamed.bytes += frame.body.byteLength;
    if (streamed.bytes > this.#maxResponseBytes) {
      this.#pending.delete(frame.id);
      this.#post({ t: 'http.abort', id: frame.id });
      pending.reject(
        new TransportError(
          'overflow',
          `The response is larger than ${String(this.#maxResponseBytes)} bytes.`,
        ),
      );
      return;
    }
    streamed.chunks.push(frame.body);
    if (!frame.last) return;
    this.#pending.delete(frame.id);
    pending.resolve({
      status: streamed.head.status,
      headers: lowerCase(streamed.head.headers),
      ...(streamed.bytes === 0
        ? {}
        : { body: concat(streamed.chunks, streamed.bytes) }),
    });
  }

  #protocolError(message: string): void {
    const error = new TransportError('protocol', message);
    this.#live?.end(error);
    this.#live = null;
  }
}

function lowerCase(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

const SERVER_FRAMES = new Set([
  'welcome',
  'subok',
  'data',
  'snapshot',
  'delta',
  'status',
  'gap',
  'end',
  'goaway',
  'pong',
]);

function isServerFrame(frame: ClientFrame | ServerFrame): frame is ServerFrame {
  return SERVER_FRAMES.has(frame.t);
}
