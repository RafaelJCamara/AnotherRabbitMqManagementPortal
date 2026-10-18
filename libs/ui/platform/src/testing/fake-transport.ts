// An EngineTransport that talks to the fake engine in memory: no port, no socket, no waiting. Live
// frames are delivered in the same call that sends them, so a spec of the LiveClient (credits,
// resume, give-up) is deterministic. It can lose its channel, like a carrier does.
import type {
  LiveChannel,
  EngineTransport,
  TransportRequest,
  TransportResponse,
} from '../engine-transport';
import { TransportError } from '../engine-transport';
import { FrameQueue } from '../frame-queue';
import type { FakeConnection, FakeEngine } from './fake-engine';
import type { ServerFrame } from '@app/contracts';

interface OpenChannel {
  readonly connection: FakeConnection;
  readonly queue: FrameQueue<ServerFrame>;
}

export class MemoryTransport implements EngineTransport {
  readonly kind = 'http';
  /** Every channel opened so far, oldest first. */
  readonly opened: OpenChannel[] = [];
  /** While true, `openLive` throws, like a carrier that cannot connect. */
  refuseLive = false;
  readonly #engine: FakeEngine;

  constructor(engine: FakeEngine) {
    this.#engine = engine;
  }

  request(request: TransportRequest): Promise<TransportResponse> {
    return this.#engine.request(request);
  }

  openLive(): LiveChannel {
    if (this.refuseLive) {
      throw new TransportError(
        'network',
        'The fake carrier refuses to connect.',
      );
    }
    const queue = new FrameQueue<ServerFrame>(4096);
    const connection = this.#engine.connect((frame) => {
      queue.push(frame);
    });
    this.opened.push({ connection, queue });
    return {
      send: (frame) => {
        if (queue.done)
          throw new TransportError('closed', 'The channel is closed.');
        connection.receive(frame);
      },
      frames: () => queue,
      close: () => {
        queue.end();
        connection.drop();
      },
    };
  }

  /** The carrier of the newest channel is lost: the engine parks the session, the client sees the end. */
  lose(): void {
    const last = this.opened[this.opened.length - 1];
    if (last === undefined) return;
    last.connection.drop();
    last.queue.end();
  }

  /** The newest connection, to inject frames a well-behaved engine would not send. */
  get connection(): FakeConnection {
    const last = this.opened[this.opened.length - 1];
    if (last === undefined) throw new Error('no live channel was opened');
    return last.connection;
  }
}
