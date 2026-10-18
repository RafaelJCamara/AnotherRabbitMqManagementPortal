// The web carrier: REST over fetch and the live protocol over one WebSocket (blueprint 7.2). The
// browser cannot set headers on a WebSocket, so the socket authenticates with a single-use ticket
// from `POST /api/v1/live/tickets`, carried in `Sec-WebSocket-Protocol: app.v1, app.ticket.<t>`.
// This library owns the only `fetch` and `WebSocket` of the UI (`@app/no-direct-fetch`).
import { isDevMode } from '@angular/core';
import {
  ServerFrameSchema,
  type ClientFrame,
  type ServerFrame,
} from '@app/contracts';

import { credentialHeaders, type EngineCredentialsSource } from './credentials';
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

export type WebSocketLike = Pick<
  WebSocket,
  | 'readyState'
  | 'send'
  | 'close'
  | 'onopen'
  | 'onmessage'
  | 'onclose'
  | 'onerror'
>;
export type WebSocketFactory = (
  url: string,
  protocols: string[],
) => WebSocketLike;
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const API_PREFIX = '/api/v1';
export const LIVE_TICKET_PATH = `${API_PREFIX}/live/tickets`;
export const LIVE_PATH = `${API_PREFIX}/live`;
export const LIVE_SUBPROTOCOL = 'app.v1';
export const LIVE_TICKET_SUBPROTOCOL_PREFIX = 'app.ticket.';

/** WebSocket.OPEN, spelled out so tests and non-browser hosts need no WebSocket global. */
const OPEN = 1;
const MAX_PENDING_SENDS = 256;

export interface HttpWsTransportOptions {
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** Defaults to `new WebSocket(url, protocols)`. */
  readonly webSocket?: WebSocketFactory;
  /** Absolute `ws:` or `wss:` URL of the live endpoint. Defaults to the page's own host. */
  readonly liveUrl?: () => string;
  /** Used for the ticket request, which does not pass through HttpClient and its interceptors. */
  readonly credentials?: EngineCredentialsSource;
  /** Check every inbound frame against the contract. Defaults to dev and test builds. */
  readonly validate?: boolean;
  readonly maxResponseBytes?: number;
  readonly maxPendingFrames?: number;
}

const TEXTUAL = /(?:^text\/|json|xml|javascript|x-www-form-urlencoded)/i;

function defaultLiveUrl(): string {
  const { protocol, host } = globalThis.location;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${LIVE_PATH}`;
}

export class HttpWsTransport implements EngineTransport {
  readonly kind = 'http';
  readonly #options: HttpWsTransportOptions;
  readonly #validate: boolean;
  readonly #maxResponseBytes: number;
  readonly #maxPendingFrames: number;

  constructor(options: HttpWsTransportOptions = {}) {
    this.#options = options;
    this.#validate = options.validate ?? isDevMode();
    this.#maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#maxPendingFrames =
      options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES;
  }

  async request(
    request: TransportRequest,
    signal?: AbortSignal,
  ): Promise<TransportResponse> {
    const doFetch: FetchLike =
      this.#options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    let response: Response;
    try {
      response = await doFetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(signal === undefined ? {} : { signal }),
        // The engine never redirects an API call, and it is the only origin we talk to.
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch (error) {
      if (signal?.aborted === true) {
        throw new TransportError('aborted', 'The request was aborted.', error);
      }
      throw new TransportError('network', 'The engine did not answer.', error);
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const declared = Number(headers['content-length']);
    if (declared > this.#maxResponseBytes) {
      void response.body?.cancel();
      throw new TransportError(
        'overflow',
        `The response is larger than ${String(this.#maxResponseBytes)} bytes.`,
      );
    }
    try {
      const body = await this.#readBody(request.method, response, headers);
      return {
        status: response.status,
        headers,
        ...(body === undefined ? {} : { body }),
      };
    } catch (error) {
      if (error instanceof TransportError) throw error;
      if (signal?.aborted === true) {
        throw new TransportError('aborted', 'The request was aborted.', error);
      }
      throw new TransportError('network', 'The response was cut off.', error);
    }
  }

  async #readBody(
    method: string,
    response: Response,
    headers: Readonly<Record<string, string>>,
  ): Promise<string | ArrayBuffer | undefined> {
    if (
      method.toUpperCase() === 'HEAD' ||
      response.status === 204 ||
      response.status === 205 ||
      response.status === 304
    ) {
      return undefined;
    }
    const contentType = headers['content-type'] ?? '';
    const body = TEXTUAL.test(contentType)
      ? await response.text()
      : await response.arrayBuffer();
    const size = typeof body === 'string' ? body.length : body.byteLength;
    if (size > this.#maxResponseBytes) {
      throw new TransportError(
        'overflow',
        `The response is larger than ${String(this.#maxResponseBytes)} bytes.`,
      );
    }
    return size === 0 ? undefined : body;
  }

  openLive(): LiveChannel {
    const queue = new FrameQueue<ServerFrame>(this.#maxPendingFrames);
    const outbound: string[] = [];
    let socket: WebSocketLike | undefined;
    let closed = false;

    const fail = (error: TransportError): void => {
      queue.end(error);
      closed = true;
      socket?.close();
    };

    const connect = async (): Promise<void> => {
      const ticket = await this.#ticket();
      if (closed) return;
      const url = (this.#options.liveUrl ?? defaultLiveUrl)();
      const protocols = [
        LIVE_SUBPROTOCOL,
        `${LIVE_TICKET_SUBPROTOCOL_PREFIX}${ticket}`,
      ];
      const ws = (this.#options.webSocket ?? ((u, p) => new WebSocket(u, p)))(
        url,
        protocols,
      );
      socket = ws;
      ws.onopen = () => {
        for (const text of outbound.splice(0)) ws.send(text);
      };
      ws.onmessage = (event) => {
        const frame = this.#decode(event.data);
        if (frame === undefined) {
          fail(new TransportError('protocol', 'invalid live frame'));
        } else {
          queue.push(frame);
        }
      };
      ws.onerror = () => {
        queue.end(new TransportError('network', 'The live socket failed.'));
      };
      ws.onclose = () => {
        closed = true;
        queue.end();
      };
    };

    connect().catch((error: unknown) => {
      queue.end(
        error instanceof TransportError
          ? error
          : new TransportError('network', 'The live socket failed.', error),
      );
      closed = true;
    });

    return {
      send: (frame: ClientFrame): void => {
        if (closed || queue.done) {
          throw new TransportError('closed', 'The live channel is closed.');
        }
        const text = JSON.stringify(frame);
        if (socket?.readyState === OPEN) {
          socket.send(text);
        } else if (outbound.length >= MAX_PENDING_SENDS) {
          throw new TransportError(
            'overflow',
            'Too many frames wait for the live socket to open.',
          );
        } else {
          outbound.push(text);
        }
      },
      frames: () => queue,
      close: (): void => {
        closed = true;
        queue.end();
        socket?.close();
      },
    };
  }

  async #ticket(): Promise<string> {
    const credentials = this.#options.credentials?.() ?? {};
    const reply = await this.request({
      method: 'POST',
      url: LIVE_TICKET_PATH,
      headers: {
        accept: 'application/json',
        ...credentialHeaders(credentials, 'POST'),
      },
    });
    if (reply.status !== 200 && reply.status !== 201) {
      throw new TransportError(
        'network',
        `The engine refused a live ticket (HTTP ${String(reply.status)}).`,
      );
    }
    const text =
      typeof reply.body === 'string'
        ? reply.body
        : new TextDecoder().decode(reply.body);
    let ticket: unknown;
    try {
      ticket = (JSON.parse(text) as { ticket?: unknown }).ticket;
    } catch {
      ticket = undefined;
    }
    if (typeof ticket !== 'string' || ticket === '') {
      throw new TransportError('protocol', 'The live ticket reply is invalid.');
    }
    return ticket;
  }

  #decode(data: unknown): ServerFrame | undefined {
    if (typeof data !== 'string') return undefined;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return undefined;
    }
    if (this.#validate) {
      const parsed = ServerFrameSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    }
    return typeof value === 'object' && value !== null && 't' in value
      ? (value as ServerFrame)
      : undefined;
  }
}
