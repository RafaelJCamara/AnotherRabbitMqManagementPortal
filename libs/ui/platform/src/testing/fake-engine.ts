// A fake engine for UI specs. It answers REST requests with a handler and runs the real live
// protocol on the server side: every connection is served by a `LiveSession` from
// `@app/live-protocol`, so a client spec exercises credits, QoS, gaps and resume against the same
// state machines the engine hub (M0-33) will drive. The two carriers (`fake-port.ts`,
// `fake-websocket.ts`) put this one engine behind a MessagePort and behind fetch plus WebSocket.
import type {
  ClientFrame,
  Problem,
  ServerFrame,
  TopicDef,
} from '@app/contracts';
import {
  LiveSession,
  ResumeRegistry,
  acceptHello,
  type SessionLimits,
  type SubFrame,
  type SubResolution,
} from '@app/live-protocol';

import type { TransportRequest, TransportResponse } from '../engine-transport';
import { LIVE_TICKET_PATH } from '../httpws-transport';

export type FakeHandler = (
  request: TransportRequest,
) => TransportResponse | Promise<TransportResponse>;

export interface FakeEngineOptions {
  readonly handler?: FakeHandler;
  readonly topics?: readonly TopicDef[];
  readonly engineVersion?: string;
  readonly limits?: Partial<SessionLimits>;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export function problemResponse(
  problem: Problem,
  headers: Readonly<Record<string, string>> = {},
): TransportResponse {
  return {
    status: problem.status,
    headers: { 'content-type': 'application/problem+json', ...headers },
    body: JSON.stringify(problem),
  };
}

const notFound = (detail: string): Problem => ({
  type: 'about:blank',
  title: 'Not found',
  status: 404,
  code: 'NOT_FOUND',
  detail,
  correlationId: 'fake-engine',
  retryable: false,
});

/** One live connection of the fake engine. Frames go in through `receive`. */
export class FakeConnection {
  readonly #engine: FakeEngine;
  readonly #send: (frame: ServerFrame) => void;
  #session: LiveSession | undefined;

  constructor(engine: FakeEngine, send: (frame: ServerFrame) => void) {
    this.#engine = engine;
    this.#send = send;
  }

  get session(): LiveSession | undefined {
    return this.#session;
  }

  receive(frame: ClientFrame): void {
    this.#engine.clientFrames.push(frame);
    const now = this.#engine.now();
    if (frame.t === 'hello') {
      const result = acceptHello(
        this.#engine.registry,
        this.#engine.newSession(),
        frame,
        now,
      );
      this.#session = result.session;
      this.#engine.attach(result.session, this);
      for (const out of result.frames) this.#send(out);
      this.pump();
      return;
    }
    const session = this.#session;
    if (session === undefined) return;
    const result = session.receive(frame);
    for (const out of result.frames) this.#send(out);
    this.pump();
  }

  /** Sends what credits allow. */
  pump(): void {
    const session = this.#session;
    if (session === undefined) return;
    for (const out of session.drain(this.#engine.now()).frames) this.#send(out);
  }

  /** The carrier went away: the session waits for a `hello{resume}`. */
  drop(): void {
    const session = this.#session;
    if (session?.state === 'open' || session?.state === 'draining') {
      session.park(this.#engine.registry, this.#engine.now());
    }
    this.#session = undefined;
  }

  /** The engine side ends the connection after a goaway. */
  send(frame: ServerFrame): void {
    this.#send(frame);
  }
}

export class FakeEngine {
  /** Every REST request, in arrival order. */
  readonly requests: TransportRequest[] = [];
  /** Every client frame of every connection, in arrival order. */
  readonly clientFrames: ClientFrame[] = [];
  readonly registry = new ResumeRegistry<LiveSession>();
  readonly sessions: LiveSession[] = [];
  readonly #options: FakeEngineOptions;
  readonly #topics = new Map<string, TopicDef>();
  readonly #state = new Map<string, unknown[]>();
  readonly #subTopics = new Map<LiveSession, Map<number, string>>();
  readonly #connections = new Map<LiveSession, FakeConnection>();
  readonly #tickets = new Set<string>();
  #clock = 0;
  #sessionCounter = 0;
  #ticketCounter = 0;

  constructor(options: FakeEngineOptions = {}) {
    this.#options = options;
    for (const topic of options.topics ?? []) {
      this.#topics.set(topic.id, topic);
      this.#state.set(topic.id, []);
    }
  }

  /** A clock the specs move with `advance`; the live session takes time as an argument. */
  now(): number {
    return this.#clock;
  }

  advance(ms: number): void {
    this.#clock += ms;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    if (request.method === 'POST' && request.url === LIVE_TICKET_PATH) {
      const ticket = `ticket-${String(++this.#ticketCounter)}`;
      this.#tickets.add(ticket);
      return jsonResponse(200, { ticket });
    }
    if (this.#options.handler === undefined) {
      return problemResponse(notFound(request.url));
    }
    return this.#options.handler(request);
  }

  /** True once per ticket (a ticket is single use). */
  redeemTicket(ticket: string): boolean {
    return this.#tickets.delete(ticket);
  }

  connect(send: (frame: ServerFrame) => void): FakeConnection {
    return new FakeConnection(this, send);
  }

  newSession(): LiveSession {
    const session: LiveSession = new LiveSession({
      id: `session-${String(++this.#sessionCounter)}`,
      engineVersion: this.#options.engineVersion ?? '0.0.0-fake',
      resolve: (sub) => this.#resolve(session, sub),
      ...(this.#options.limits === undefined
        ? {}
        : { limits: this.#options.limits }),
    });
    return session;
  }

  attach(session: LiveSession, connection: FakeConnection): void {
    if (!this.sessions.includes(session)) this.sessions.push(session);
    this.#connections.set(session, connection);
  }

  /** Offers one item of a topic to every subscription of it, then sends what credits allow. */
  publish(topicId: string, item: unknown): void {
    const topic = this.#topics.get(topicId);
    if (topic === undefined) throw new Error(`unknown topic ${topicId}`);
    const items = this.#state.get(topicId) ?? [];
    const key = topic.key?.(item);
    const at =
      key === undefined ? -1 : items.findIndex((i) => topic.key?.(i) === key);
    if (at >= 0) items[at] = item;
    else items.push(item);
    const bytes = JSON.stringify(item).length;
    for (const [session, subs] of this.#subTopics) {
      for (const [sid, id] of subs) {
        if (id === topicId) session.publish(sid, { value: item, bytes });
      }
    }
    this.pumpAll();
  }

  /** `snapshot-delta` only: the keyed item is gone. */
  remove(topicId: string, key: string): void {
    const topic = this.#topics.get(topicId);
    if (topic === undefined) throw new Error(`unknown topic ${topicId}`);
    const items = this.#state.get(topicId) ?? [];
    this.#state.set(
      topicId,
      items.filter((item) => topic.key?.(item) !== key),
    );
    for (const [session, subs] of this.#subTopics) {
      for (const [sid, id] of subs) {
        if (id === topicId) session.publishRemove(sid, key);
      }
    }
    this.pumpAll();
  }

  /** Asks every client of a session to reconnect, as the engine does when it drains. */
  goaway(
    session: LiveSession,
    reason: 'drain' | 'version-mismatch' | 'auth-expired',
    reconnectAfterMs?: number,
  ): void {
    this.#connections
      .get(session)
      ?.send(session.goaway(reason, reconnectAfterMs));
  }

  pumpAll(): void {
    for (const connection of this.#connections.values()) connection.pump();
  }

  /** Ends a subscription from the engine side and tells the client. */
  endSubscription(
    session: LiveSession,
    sid: number,
    reason: 'completed' | 'lease_expired' | 'error',
    problem?: Problem,
  ): void {
    const connection = this.#connections.get(session);
    for (const frame of session.end(sid, reason, problem)) {
      connection?.send(frame);
    }
  }

  #resolve(session: LiveSession, sub: SubFrame): SubResolution {
    const topic = this.#topics.get(sub.topic);
    if (topic === undefined) {
      return { ok: false, problem: notFound(`topic ${sub.topic}`) };
    }
    const params = topic.params.safeParse(sub.params);
    if (!params.success) {
      return {
        ok: false,
        problem: {
          type: 'about:blank',
          title: 'Validation failed',
          status: 400,
          code: 'VALIDATION_FAILED',
          correlationId: 'fake-engine',
          retryable: false,
        },
      };
    }
    const subs = this.#subTopics.get(session) ?? new Map<number, string>();
    subs.set(sub.sid, topic.id);
    this.#subTopics.set(session, subs);
    return {
      ok: true,
      spec: {
        qos: topic.qos,
        flow: topic.flow,
        ring: topic.ring,
        ...(topic.maxHz === undefined ? {} : { maxHz: topic.maxHz }),
        ...(topic.key === undefined
          ? {}
          : { key: (item: unknown) => topic.key?.(item) ?? '' }),
        snapshot: () => {
          const value = [...(this.#state.get(topic.id) ?? [])];
          return { value, bytes: JSON.stringify(value).length };
        },
      },
    };
  }
}
