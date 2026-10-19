// A hub session and the connection that currently carries it (blueprint 3.5).
//
// `HubSession` is what outlives a transport: the protocol state machine (`LiveSession` of
// `@app/live-protocol`), the principal it acts for and the topic sources feeding its outboxes.
// `LiveConnection` is one transport bound to a session: it decodes client frames, sends what the
// session's credits allow, arms the pacing timer and parks the session when the transport is lost.
// Neither knows whether the bytes travel on a WebSocket or a MessagePort.
import {
  ClientFrameSchema,
  type ClientFrame,
  type Permission,
  type Problem,
  type ServerFrame,
  type TopicDef,
} from '@app/contracts';
import {
  acceptHello,
  LiveSession,
  type Received,
  type ResumeRegistry,
  type SessionLimits,
  type SubFrame,
  type SubResolution,
} from '@app/live-protocol';
import { AppError, toProblem, type Clock, type Timers } from '@app/kernel';
import type { Principal } from '@app/ports';

import type { TopicRegistry, TopicSink } from './topic-registry.ts';

/** What the hub needs of a transport; a WebSocket and a MessagePort both fit behind it. */
export interface LiveTransport {
  /** Sends one text frame. May throw when the transport is gone. */
  send(text: string): void;
  close(code: number, reason: string): void;
  /** Bytes accepted by `send` that the peer has not read yet. */
  readonly bufferedAmount: number;
}

/** What the carrier calls: one per accepted connection. Both are safe to repeat or reorder. */
export interface LiveLink {
  /** A text frame arrived. */
  receive(text: string): void;
  /** The transport is gone. The session stays parked for the resume window. */
  closed(): void;
}

export interface HubDeps {
  readonly engineVersion: string;
  readonly topics: TopicRegistry;
  /** Synchronous on purpose: a `sub` is answered in order. Refuse unless the principal may. */
  readonly canSubscribe: (
    principal: Principal,
    permission: Permission,
  ) => boolean;
  readonly clock: Clock;
  readonly timers: Timers;
  readonly limits: Partial<SessionLimits>;
  /** A transport that holds more unsent bytes than this is closed (the session stays parked). */
  readonly maxBufferedBytes: number;
  /** Largest client frame in bytes; `hello`, `sub` and `credit` are tiny. */
  readonly maxClientFrameBytes: number;
  /** Check every published item against `TopicDef.item` (a cost for tests and dev builds). */
  readonly validateItems: boolean;
  readonly newSessionId: () => string;
}

/** The hub as a connection sees it. */
export interface SessionHost {
  readonly deps: HubDeps;
  readonly registry: ResumeRegistry<LiveSession>;
  readonly sessions: Map<string, HubSession>;
  adopt(session: HubSession): void;
  park(session: HubSession): void;
  drop(session: HubSession): void;
}

const byteLength = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));

export class HubSession {
  readonly live: LiveSession;
  readonly principal: Principal;
  /** The connection carrying the session now; undefined while it is parked. */
  connection: LiveConnection | undefined;
  readonly #deps: HubDeps;
  readonly #starts = new Map<number, () => void>();
  readonly #sources = new Map<number, () => void>();
  /** `end` frames produced while parked; sent after the resume `welcome` (one per sid at most). */
  readonly #endedWhileParked: ServerFrame[] = [];

  constructor(id: string, principal: Principal, deps: HubDeps) {
    this.principal = principal;
    this.#deps = deps;
    this.live = new LiveSession({
      id,
      engineVersion: deps.engineVersion,
      resolve: (frame) => this.#resolve(frame),
      limits: deps.limits,
    });
  }

  /** `LiveSession.receive`, plus starting a source when a subscription is accepted. */
  receive(frame: ClientFrame): Received {
    const result = this.live.receive(frame);
    const frames: ServerFrame[] = [];
    for (const out of result.frames) {
      frames.push(out);
      if (out.t === 'end') this.#stop(out.sid);
      if (out.t === 'subok') frames.push(...this.#start(out.sid));
    }
    return result.violation === undefined
      ? { frames }
      : { frames, violation: result.violation };
  }

  /** Frames that ended subscriptions while no transport was attached. */
  takeEnded(): ServerFrame[] {
    return this.#endedWhileParked.splice(0);
  }

  /** Stops every source and closes the protocol session. */
  close(): void {
    for (const stop of this.#sources.values()) stop();
    this.#sources.clear();
    this.#starts.clear();
    this.live.close();
  }

  #refuse(problem: Problem): SubResolution {
    return { ok: false, problem };
  }

  #resolve(frame: SubFrame): SubResolution {
    const found = this.#deps.topics.lookup(frame.topic);
    const correlationId = this.live.id;
    if (found === undefined) {
      return this.#refuse(
        toProblem(new AppError('NOT_FOUND', { detail: 'No such topic.' }), {
          correlationId,
        }),
      );
    }
    const { def, source } = found;
    if (!this.#deps.canSubscribe(this.principal, def.permission)) {
      return this.#refuse(
        toProblem(
          new AppError('FORBIDDEN_RBAC', {
            detail: 'Not permitted to subscribe.',
            missingPermission: def.permission,
          }),
          { correlationId },
        ),
      );
    }
    const parsed = def.params.safeParse(frame.params);
    if (!parsed.success) {
      return this.#refuse(toProblem(parsed.error, { correlationId }));
    }
    const params: unknown = parsed.data;
    const principal = this.principal;
    this.#starts.set(frame.sid, () => {
      this.#sources.set(
        frame.sid,
        source.subscribe(params, principal, this.#sink(frame.sid, def)),
      );
    });
    return {
      ok: true,
      spec: {
        qos: def.qos,
        flow: def.flow,
        ring: def.ring,
        ...(def.maxHz === undefined ? {} : { maxHz: def.maxHz }),
        ...(def.key === undefined
          ? {}
          : {
              key: (item: unknown) => (def.key as (i: unknown) => string)(item),
            }),
        snapshot: () => source.snapshot(params, principal),
      },
    };
  }

  /** Runs the source of a new subscription; a source that throws ends it with INTERNAL. */
  #start(sid: number): ServerFrame[] {
    const start = this.#starts.get(sid);
    this.#starts.delete(sid);
    try {
      start?.();
      return [];
    } catch (error) {
      this.#stop(sid);
      return this.live.end(
        sid,
        'error',
        toProblem(error, { correlationId: this.live.id }),
      );
    }
  }

  #stop(sid: number): void {
    this.#starts.delete(sid);
    const stop = this.#sources.get(sid);
    this.#sources.delete(sid);
    stop?.();
  }

  #sink(sid: number, def: TopicDef): TopicSink<unknown> {
    const wake = (): void => this.connection?.wake();
    return {
      publish: (item, bytes) => {
        if (this.#deps.validateItems) def.item.parse(item);
        this.live.publish(sid, {
          value: item,
          bytes: bytes ?? byteLength(item),
        });
        wake();
      },
      remove: (key) => {
        this.live.publishRemove(sid, key);
        wake();
      },
      end: (problem) => {
        const frames = this.live.end(
          sid,
          problem === undefined ? 'completed' : 'error',
          problem,
        );
        this.#stop(sid);
        if (this.connection === undefined) {
          this.#endedWhileParked.push(...frames);
        } else {
          this.connection.send(frames);
        }
      },
    };
  }
}

/** Why a connection is closed (RFC 6455 codes). */
const CLOSE = {
  policy: 1008,
  tooBig: 1009,
  tryAgain: 1013,
} as const;

function decode(
  text: string,
  maxBytes: number,
): ClientFrame | 'too-big' | undefined {
  if (Buffer.byteLength(text) > maxBytes) return 'too-big';
  try {
    const parsed = ClientFrameSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export class LiveConnection implements LiveLink {
  readonly #host: SessionHost;
  readonly #transport: LiveTransport;
  readonly #principal: Principal;
  #session: HubSession | undefined;
  #cancelWake: (() => void) | undefined;
  #pumpQueued = false;
  #done = false;

  constructor(
    host: SessionHost,
    transport: LiveTransport,
    principal: Principal,
  ) {
    this.#host = host;
    this.#transport = transport;
    this.#principal = principal;
  }

  receive(text: string): void {
    if (this.#done) return;
    const frame = decode(text, this.#host.deps.maxClientFrameBytes);
    if (frame === undefined || frame === 'too-big') {
      this.#violate(
        frame === undefined ? CLOSE.policy : CLOSE.tooBig,
        'invalid frame',
      );
    } else if (this.#session !== undefined) {
      const result = this.#session.receive(frame);
      this.send(result.frames);
      if (result.violation === undefined) this.wake();
      else this.#violate(CLOSE.policy, result.violation);
    } else if (frame.t === 'hello') {
      this.#hello(frame);
    } else {
      this.#violate(CLOSE.policy, 'hello must come first');
    }
  }

  closed(): void {
    if (this.#done) return;
    this.#done = true;
    this.#cancelWake?.();
    const session = this.#session;
    if (session === undefined) return;
    session.connection = undefined;
    const state = session.live.state;
    if (state === 'open' || state === 'draining') this.#host.park(session);
    else this.#host.drop(session);
  }

  /** Asks the client to reconnect (engine drain or restart) and closes. */
  goaway(
    reason: 'drain' | 'version-mismatch',
    reconnectAfterMs?: number,
  ): void {
    const session = this.#session;
    if (session !== undefined && !this.#done) {
      this.send([session.live.goaway(reason, reconnectAfterMs)]);
    }
    this.#transport.close(1001, 'going away');
    this.closed();
  }

  /** Drains the session soon, once per burst of publications. */
  wake(): void {
    if (this.#pumpQueued || this.#done) return;
    this.#pumpQueued = true;
    queueMicrotask(() => {
      this.#pumpQueued = false;
      this.#pump();
    });
  }

  send(frames: readonly ServerFrame[]): void {
    if (frames.length === 0 || this.#done) return;
    if (this.#transport.bufferedAmount > this.#host.deps.maxBufferedBytes) {
      // The peer does not read: stop here and keep the session for a resume.
      this.#transport.close(CLOSE.tryAgain, 'slow consumer');
      this.closed();
      return;
    }
    try {
      for (const frame of frames) this.#transport.send(JSON.stringify(frame));
    } catch {
      this.closed();
    }
  }

  #hello(frame: Extract<ClientFrame, { t: 'hello' }>): void {
    const { sessions, registry, deps } = this.#host;
    // A session can only be resumed by the principal it belongs to.
    const resumable =
      frame.resume !== undefined &&
      sessions.get(frame.resume.session)?.principal.id === this.#principal.id;
    const fresh = new HubSession(deps.newSessionId(), this.#principal, deps);
    const result = acceptHello(
      registry,
      fresh.live,
      resumable ? frame : { t: 'hello', v: 1 },
      deps.clock.monotonic(),
    );
    const resumed =
      result.session === fresh.live
        ? undefined
        : sessions.get(result.session.id);
    const session = resumed ?? fresh;
    if (resumed === undefined) this.#host.adopt(fresh);
    session.connection = this;
    this.#session = session;
    this.send(result.frames);
    if (resumed !== undefined) this.send(resumed.takeEnded());
    this.wake();
  }

  #pump(): void {
    const session = this.#session;
    if (session === undefined || this.#done) return;
    const { clock, timers } = this.#host.deps;
    const now = clock.monotonic();
    const { frames, wakeAt } = session.live.drain(now);
    this.send(frames);
    this.#cancelWake?.();
    this.#cancelWake =
      wakeAt === null || this.#finished()
        ? undefined
        : timers.setTimer(() => {
            this.#pump();
          }, wakeAt - now);
  }

  #finished(): boolean {
    return this.#done;
  }

  #violate(code: number, reason: string): void {
    this.#transport.close(code, reason);
    this.#done = true;
    this.#cancelWake?.();
    if (this.#session !== undefined) {
      this.#session.connection = undefined;
      this.#host.drop(this.#session);
    }
  }
}
