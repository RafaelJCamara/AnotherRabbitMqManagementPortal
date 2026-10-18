// The engine side of fetch plus WebSocket: a fetch that answers from the fake engine, and a
// WebSocket factory that checks the single-use ticket and then carries the live protocol as JSON
// text frames, like the engine's `ws` endpoint will.
import type { ClientFrame } from '@app/contracts';

import type {
  FetchLike,
  WebSocketFactory,
  WebSocketLike,
} from '../httpws-transport';
import { LIVE_TICKET_SUBPROTOCOL_PREFIX } from '../httpws-transport';
import { isArrayBuffer } from '../engine-transport';
import type { FakeConnection, FakeEngine } from './fake-engine';

export function createFakeFetch(engine: FakeEngine): FetchLike {
  return async (input, init) => {
    if (init.signal?.aborted === true) {
      throw new DOMException('aborted', 'AbortError');
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body;
    if (
      body !== undefined &&
      body !== null &&
      typeof body !== 'string' &&
      !isArrayBuffer(body)
    ) {
      throw new TypeError('the fake fetch takes string and ArrayBuffer bodies');
    }
    const reply = await engine.request({
      method: init.method ?? 'GET',
      url: input,
      headers,
      ...(body === undefined || body === null ? {} : { body }),
    });
    const noBody =
      reply.status === 204 || reply.status === 205 || reply.status === 304;
    return new Response(noBody ? null : (reply.body ?? null), {
      status: reply.status,
      headers: { ...reply.headers },
    });
  };
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export class FakeWebSocket implements WebSocketLike {
  readyState: WebSocketLike['readyState'] = CONNECTING;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  /** Subprotocols the client offered. */
  readonly protocols: readonly string[];
  #connection: FakeConnection | undefined;
  readonly #engine: FakeEngine;

  constructor(engine: FakeEngine, protocols: readonly string[]) {
    this.#engine = engine;
    this.protocols = protocols;
    queueMicrotask(() => {
      this.#open();
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== OPEN || typeof data !== 'string') {
      throw new Error('the fake socket is not open');
    }
    this.#connection?.receive(JSON.parse(data) as ClientFrame);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.#connection?.drop();
    this.onclose?.call(this as unknown as WebSocket, new CloseEvent('close'));
  }

  #open(): void {
    const ticket = this.protocols
      .find((p) => p.startsWith(LIVE_TICKET_SUBPROTOCOL_PREFIX))
      ?.slice(LIVE_TICKET_SUBPROTOCOL_PREFIX.length);
    if (ticket === undefined || !this.#engine.redeemTicket(ticket)) {
      this.close();
      return;
    }
    this.readyState = OPEN;
    this.#connection = this.#engine.connect((frame) => {
      if (this.readyState !== OPEN) return;
      this.onmessage?.call(
        this as unknown as WebSocket,
        new MessageEvent('message', { data: JSON.stringify(frame) }),
      );
    });
    this.onopen?.call(this as unknown as WebSocket, new Event('open'));
  }
}

export function createFakeWebSocketFactory(
  engine: FakeEngine,
  opened: FakeWebSocket[] = [],
): WebSocketFactory {
  return (_url, protocols) => {
    const socket = new FakeWebSocket(engine, protocols);
    opened.push(socket);
    return socket;
  };
}
