import type { PortFrame, ServerFrame } from '@app/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { TransportError } from './engine-transport';
import { MessagePortTransport } from './messageport-transport';
import {
  FakeEngine,
  createFakePort,
  jsonResponse,
  tick,
  waitFor,
} from './testing';

const welcome: ServerFrame = {
  t: 'welcome',
  v: 1,
  session: 's1',
  engineVersion: '1.0.0',
  limits: { maxSubs: 64, outboxBytes: 8_388_608, maxFrameBytes: 1_048_576 },
};

describe('MessagePortTransport', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  /** A transport on one end of a raw channel; the spec plays the engine on the other end. */
  function rawChannel(
    options: ConstructorParameters<typeof MessagePortTransport>[1] = {},
  ) {
    const channel = new MessageChannel();
    const received: PortFrame[] = [];
    channel.port1.onmessage = (event: MessageEvent<PortFrame>) => {
      received.push(event.data);
    };
    const transport = new MessagePortTransport(channel.port2, {
      validate: true,
      ...options,
    });
    cleanup.push(() => {
      transport.close();
      channel.port1.close();
    });
    return { engine: channel.port1, transport, received };
  }

  it('tunnels a request as http.req and resolves with the http.res body', async () => {
    const { engine, transport, received } = rawChannel();
    const pending = transport.request({
      method: 'POST',
      url: '/api/v1/x',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    await waitFor(() => received.length === 1, 'the request frame');
    expect(received[0]).toEqual({
      t: 'http.req',
      id: 0,
      method: 'POST',
      url: '/api/v1/x',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    engine.postMessage({
      t: 'http.res',
      id: 0,
      status: 201,
      headers: { 'Content-Type': 'application/json' },
      body: '{"ok":true}',
    } satisfies PortFrame);
    expect(await pending).toEqual({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
  });

  it('matches concurrent answers to their requests by id', async () => {
    const { engine, transport, received } = rawChannel();
    const first = transport.request({ method: 'GET', url: '/a', headers: {} });
    const second = transport.request({ method: 'GET', url: '/b', headers: {} });
    await waitFor(() => received.length === 2, 'two request frames');
    for (const id of [1, 0]) {
      engine.postMessage({
        t: 'http.res',
        id,
        status: 200,
        headers: {},
        body: `answer ${String(id)}`,
      } satisfies PortFrame);
    }
    expect((await first).body).toBe('answer 0');
    expect((await second).body).toBe('answer 1');
  });

  it('assembles a streamed response from its chunks', async () => {
    const engine = new FakeEngine({
      handler: () => ({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).buffer,
      }),
    });
    const port = createFakePort(engine, { streamThreshold: 4, chunkSize: 3 });
    const transport = new MessagePortTransport(port.renderer, {
      validate: false,
    });
    cleanup.push(() => {
      transport.close();
      port.closeEngineSide();
    });
    const reply = await transport.request({
      method: 'GET',
      url: '/blob',
      headers: {},
    });
    expect(new Uint8Array(reply.body as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    );
  });

  it('aborts a streamed response that outgrows maxResponseBytes and tells the engine', async () => {
    const { engine, transport, received } = rawChannel({
      maxResponseBytes: 5,
      validate: false,
    });
    const pending = transport.request({
      method: 'GET',
      url: '/big',
      headers: {},
    });
    pending.catch(() => undefined);
    await waitFor(() => received.length === 1);
    engine.postMessage({
      t: 'http.res',
      id: 0,
      status: 200,
      headers: {},
      streamed: true,
    } satisfies PortFrame);
    engine.postMessage({
      t: 'http.chunk',
      id: 0,
      body: new ArrayBuffer(4),
      last: false,
    } satisfies PortFrame);
    engine.postMessage({
      t: 'http.chunk',
      id: 0,
      body: new ArrayBuffer(4),
      last: false,
    } satisfies PortFrame);
    await expect(pending).rejects.toMatchObject({ reason: 'overflow' });
    await waitFor(
      () => received.some((f) => f.t === 'http.abort'),
      'http.abort',
    );
  });

  it('aborts: sends http.abort once and rejects with an aborted error', async () => {
    const { transport, received } = rawChannel();
    const controller = new AbortController();
    const pending = transport.request(
      { method: 'GET', url: '/slow', headers: {} },
      controller.signal,
    );
    await waitFor(() => received.length === 1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'aborted' });
    await waitFor(() => received.length === 2);
    expect(received[1]).toEqual({ t: 'http.abort', id: 0 });
  });

  it('rejects at once when the signal is already aborted, without sending', async () => {
    const { transport, received } = rawChannel();
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport.request(
        { method: 'GET', url: '/x', headers: {} },
        controller.signal,
      ),
    ).rejects.toMatchObject({ reason: 'aborted' });
    await tick(5);
    expect(received).toEqual([]);
  });

  it('ignores an answer that arrives after the abort', async () => {
    const { engine, transport, received } = rawChannel();
    const controller = new AbortController();
    const pending = transport.request(
      { method: 'GET', url: '/slow', headers: {} },
      controller.signal,
    );
    pending.catch(() => undefined);
    await waitFor(() => received.length === 1);
    controller.abort();
    engine.postMessage({
      t: 'http.res',
      id: 0,
      status: 200,
      headers: {},
      body: 'late',
    } satisfies PortFrame);
    await expect(pending).rejects.toBeInstanceOf(TransportError);
  });

  it('close() fails pending requests and ends the live channel', async () => {
    const { transport, received } = rawChannel();
    const live = transport.openLive();
    const pending = transport.request({
      method: 'GET',
      url: '/x',
      headers: {},
    });
    await waitFor(() => received.length === 1);
    transport.close();
    await expect(pending).rejects.toMatchObject({ reason: 'closed' });
    expect(() => {
      live.send({ t: 'ping', ts: 1 });
    }).toThrow(TransportError);
    const frames: ServerFrame[] = [];
    for await (const frame of live.frames()) frames.push(frame);
    expect(frames).toEqual([]);
    await expect(
      transport.request({ method: 'GET', url: '/y', headers: {} }),
    ).rejects.toMatchObject({ reason: 'closed' });
  });

  it('carries live frames both ways as `live` frames', async () => {
    const { engine, transport, received } = rawChannel();
    const live = transport.openLive();
    live.send({ t: 'hello', v: 1 });
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ t: 'live', frame: { t: 'hello', v: 1 } });
    engine.postMessage({ t: 'live', frame: welcome } satisfies PortFrame);
    engine.postMessage({
      t: 'live',
      frame: { t: 'pong', ts: 5 },
    } satisfies PortFrame);
    const iterator = live.frames()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(welcome);
    expect((await iterator.next()).value).toEqual({ t: 'pong', ts: 5 });
  });

  it('fails the live channel with a protocol error on a frame the contract does not allow', async () => {
    const { engine, transport } = rawChannel();
    const live = transport.openLive();
    engine.postMessage({ t: 'live', frame: { t: 'pong', ts: 'late' } });
    const iterator = live.frames()[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ reason: 'protocol' });
  });

  it('treats a client frame from the engine as a protocol error', async () => {
    const { engine, transport } = rawChannel();
    const live = transport.openLive();
    engine.postMessage({
      t: 'live',
      frame: { t: 'ping', ts: 1 },
    } satisfies PortFrame);
    const iterator = live.frames()[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ reason: 'protocol' });
  });

  it('ends the previous live channel when a new one opens (one session per UI)', async () => {
    const { transport } = rawChannel();
    const first = transport.openLive();
    transport.openLive();
    const frames: ServerFrame[] = [];
    for await (const frame of first.frames()) frames.push(frame);
    expect(frames).toEqual([]);
  });

  it('a live channel opened on a closed port ends at once and refuses sends', async () => {
    const { transport } = rawChannel();
    transport.close();
    const live = transport.openLive();
    expect(() => {
      live.send({ t: 'hello', v: 1 });
    }).toThrow(TransportError);
    for await (const frame of live.frames()) expect(frame).toBeUndefined();
  });

  it('answers a request through the fake engine like any carrier', async () => {
    const engine = new FakeEngine({
      handler: () => jsonResponse(200, { ok: true }),
    });
    const port = createFakePort(engine);
    const transport = new MessagePortTransport(port.renderer);
    cleanup.push(() => {
      transport.close();
      port.closeEngineSide();
    });
    const reply = await transport.request({
      method: 'GET',
      url: '/api/v1/meta',
      headers: {},
    });
    expect(reply).toMatchObject({ status: 200, body: '{"ok":true}' });
  });
});
