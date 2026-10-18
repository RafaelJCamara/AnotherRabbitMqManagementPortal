// The engine side of a MessagePort, as `PortSessionServer` will be (blueprint 3.3): `http.req`
// frames go to the fake engine, answers come back as `http.res` (and `http.chunk` for big bodies),
// and `live` frames feed one live connection. The renderer's end is a real MessagePort.
import type { ClientFrame, PortFrame } from '@app/contracts';

import { isArrayBuffer } from '../engine-transport';
import type { FakeConnection, FakeEngine } from './fake-engine';

export interface FakePortOptions {
  /** Answers larger than this many bytes are streamed as chunks. */
  readonly streamThreshold?: number;
  readonly chunkSize?: number;
}

export interface FakePort {
  /** The end the renderer's MessagePortTransport gets. */
  readonly renderer: MessagePort;
  /** Ids of requests the renderer aborted. */
  readonly aborted: ReadonlySet<number>;
  /** Simulates the engine going away: the renderer's port closes. */
  closeEngineSide(): void;
}

export function createFakePort(
  engine: FakeEngine,
  options: FakePortOptions = {},
): FakePort {
  const streamThreshold = options.streamThreshold ?? 1024 * 1024;
  const chunkSize = options.chunkSize ?? 64 * 1024;
  const channel = new MessageChannel();
  const server = channel.port1;
  const aborted = new Set<number>();
  let connection: FakeConnection | undefined;

  const post = (frame: PortFrame): void => {
    server.postMessage(frame);
  };

  const answer = async (
    frame: Extract<PortFrame, { t: 'http.req' }>,
  ): Promise<void> => {
    const reply = await engine.request({
      method: frame.method,
      url: frame.url,
      headers: frame.headers,
      ...(frame.body === undefined ? {} : { body: frame.body }),
    });
    if (aborted.has(frame.id)) return;
    const body = reply.body;
    if (
      body !== undefined &&
      isArrayBuffer(body) &&
      body.byteLength > streamThreshold
    ) {
      post({
        t: 'http.res',
        id: frame.id,
        status: reply.status,
        headers: { ...reply.headers },
        streamed: true,
      });
      for (let at = 0; at < body.byteLength; at += chunkSize) {
        post({
          t: 'http.chunk',
          id: frame.id,
          body: body.slice(at, at + chunkSize),
          last: at + chunkSize >= body.byteLength,
        });
      }
      return;
    }
    post({
      t: 'http.res',
      id: frame.id,
      status: reply.status,
      headers: { ...reply.headers },
      ...(body === undefined ? {} : { body }),
    });
  };

  server.onmessage = (event: MessageEvent<PortFrame>) => {
    const frame = event.data;
    switch (frame.t) {
      case 'http.req':
        void answer(frame);
        return;
      case 'http.abort':
        aborted.add(frame.id);
        return;
      case 'live':
        if (frame.frame.t === 'hello') {
          connection?.drop();
          connection = engine.connect((out) => {
            post({ t: 'live', frame: out });
          });
        }
        connection?.receive(frame.frame as ClientFrame);
        return;
      case 'http.res':
      case 'http.chunk':
        return;
    }
  };

  return {
    renderer: channel.port2,
    aborted,
    closeEngineSide: () => {
      connection?.drop();
      server.close();
    },
  };
}
