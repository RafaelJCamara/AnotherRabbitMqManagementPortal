import type { ServerFrame } from '@app/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TransportError } from './engine-transport';
import {
  HttpWsTransport,
  type FetchLike,
  type WebSocketLike,
} from './httpws-transport';
import {
  FakeEngine,
  FakeWebSocket,
  createFakeFetch,
  createFakeWebSocketFactory,
  jsonResponse,
  tick,
  waitFor,
} from './testing';

describe('HttpWsTransport', () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  function setup(handler?: ConstructorParameters<typeof FakeEngine>[0]) {
    const engine = new FakeEngine(handler);
    const sockets: FakeWebSocket[] = [];
    const fetchSpy = vi.fn(createFakeFetch(engine));
    const transport = new HttpWsTransport({
      fetch: fetchSpy,
      webSocket: createFakeWebSocketFactory(engine, sockets),
      liveUrl: () => 'ws://engine.test/api/v1/live',
      credentials: () => ({ bearer: 'launch-token' }),
      validate: true,
    });
    return { engine, sockets, fetchSpy, transport };
  }

  it('sends a request same-origin, without redirects or caching, and returns status, headers and text', async () => {
    const { transport, fetchSpy, engine } = setup({
      handler: () => jsonResponse(200, { ok: 1 }, { 'X-Thing': 'a' }),
    });
    const reply = await transport.request({
      method: 'POST',
      url: '/api/v1/x?y=1',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(reply).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-thing': 'a' },
      body: '{"ok":1}',
    });
    expect(engine.requests[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/x?y=1',
      body: '{"a":1}',
    });
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  });

  it('returns binary content as an ArrayBuffer and no body for 204', async () => {
    const { transport } = setup({
      handler: (request) =>
        request.url === '/empty'
          ? { status: 204, headers: {} }
          : {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
              body: new Uint8Array([7, 8]).buffer,
            },
    });
    const binary = await transport.request({
      method: 'GET',
      url: '/bin',
      headers: {},
    });
    expect(new Uint8Array(binary.body as ArrayBuffer)).toEqual(
      new Uint8Array([7, 8]),
    );
    const empty = await transport.request({
      method: 'DELETE',
      url: '/empty',
      headers: {},
    });
    expect(empty.status).toBe(204);
    expect('body' in empty).toBe(false);
  });

  it('reports an unreachable engine as a network TransportError', async () => {
    const failing: FetchLike = () =>
      Promise.reject(new TypeError('Failed to fetch'));
    const transport = new HttpWsTransport({ fetch: failing });
    await expect(
      transport.request({ method: 'GET', url: '/x', headers: {} }),
    ).rejects.toMatchObject({ name: 'TransportError', reason: 'network' });
  });

  it('reports an aborted request as aborted, not as a network failure', async () => {
    const controller = new AbortController();
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const transport = new HttpWsTransport({ fetch: hanging });
    const pending = transport.request(
      { method: 'GET', url: '/slow', headers: {} },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'aborted' });
  });

  it('refuses a response whose declared length exceeds the limit', async () => {
    const big: FetchLike = () =>
      Promise.resolve(
        new Response('x', {
          status: 200,
          headers: { 'content-length': '999' },
        }),
      );
    const transport = new HttpWsTransport({ fetch: big, maxResponseBytes: 10 });
    await expect(
      transport.request({ method: 'GET', url: '/big', headers: {} }),
    ).rejects.toMatchObject({ reason: 'overflow' });
  });

  describe('live channel', () => {
    it('gets a ticket with the credentials, then opens the socket with the ticket subprotocol', async () => {
      const { transport, sockets, fetchSpy } = setup();
      const live = transport.openLive();
      live.send({ t: 'hello', v: 1 });
      const iterator = live.frames()[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect((first.value as ServerFrame).t).toBe('welcome');
      expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/v1/live/tickets');
      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
        method: 'POST',
        headers: { authorization: 'Bearer launch-token' },
      });
      expect(sockets[0]?.protocols).toEqual(['app.v1', 'app.ticket.ticket-1']);
      live.close();
    });

    it('holds frames sent before the socket is open and sends them in order', async () => {
      const { transport, engine } = setup();
      const live = transport.openLive();
      live.send({ t: 'hello', v: 1 });
      live.send({ t: 'ping', ts: 42 });
      const iterator = live.frames()[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ t: 'welcome' });
      expect((await iterator.next()).value).toEqual({ t: 'pong', ts: 42 });
      expect(engine.clientFrames.map((f) => f.t)).toEqual(['hello', 'ping']);
      live.close();
    });

    it('fails the channel when the engine refuses the ticket', async () => {
      const refusing: FetchLike = () =>
        Promise.resolve(new Response('{}', { status: 401 }));
      const transport = new HttpWsTransport({ fetch: refusing });
      const live = transport.openLive();
      const iterator = live.frames()[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toBeInstanceOf(TransportError);
      expect(() => {
        live.send({ t: 'hello', v: 1 });
      }).toThrow(TransportError);
    });

    it('fails the channel with a protocol error when the ticket reply has no ticket', async () => {
      const odd: FetchLike = () =>
        Promise.resolve(
          new Response('{"nope":1}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      const transport = new HttpWsTransport({ fetch: odd });
      const iterator = transport.openLive().frames()[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toMatchObject({
        reason: 'protocol',
      });
    });

    it('closes the socket and fails the channel on a frame the contract does not allow', async () => {
      const { transport, sockets } = setup();
      const live = transport.openLive();
      live.send({ t: 'hello', v: 1 });
      const iterator = live.frames()[Symbol.asyncIterator]();
      await iterator.next();
      sockets[0]?.onmessage?.call(
        sockets[0] as unknown as WebSocket,
        new MessageEvent('message', { data: '{"t":"pong","ts":"x"}' }),
      );
      await expect(iterator.next()).rejects.toMatchObject({
        reason: 'protocol',
      });
      expect(sockets[0]?.readyState).toBe(3);
    });

    it('ends the frames when the socket closes', async () => {
      const { transport, sockets } = setup();
      const live = transport.openLive();
      live.send({ t: 'hello', v: 1 });
      const iterator = live.frames()[Symbol.asyncIterator]();
      await iterator.next();
      sockets[0]?.close();
      expect(await iterator.next()).toEqual({ value: undefined, done: true });
    });

    it('close() closes the socket, ends the frames and refuses further sends', async () => {
      const { transport, sockets } = setup();
      const live = transport.openLive();
      live.send({ t: 'hello', v: 1 });
      const iterator = live.frames()[Symbol.asyncIterator]();
      await iterator.next();
      live.close();
      expect(sockets[0]?.readyState).toBe(3);
      expect(await iterator.next()).toEqual({ value: undefined, done: true });
      expect(() => {
        live.send({ t: 'ping', ts: 1 });
      }).toThrow(TransportError);
    });

    it('does not open a socket for a channel closed before its ticket arrived', async () => {
      const { transport, sockets } = setup();
      transport.openLive().close();
      await tick(10);
      expect(sockets).toEqual([]);
    });

    it('bounds the frames held while the socket is not open', async () => {
      const never: WebSocketLike = {
        readyState: 0,
        send: vi.fn(),
        close: vi.fn(),
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      const engine = new FakeEngine();
      const transport = new HttpWsTransport({
        fetch: createFakeFetch(engine),
        webSocket: () => never,
        liveUrl: () => 'ws://engine.test/api/v1/live',
      });
      const live = transport.openLive();
      await waitFor(() => engine.requests.length === 1, 'the ticket request');
      for (let i = 0; i < 256; i += 1) live.send({ t: 'ping', ts: i });
      let failure: unknown;
      try {
        live.send({ t: 'ping', ts: 256 });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ reason: 'overflow' });
      live.close();
    });
  });
});
