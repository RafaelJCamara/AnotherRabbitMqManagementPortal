// One live session (blueprint 3.5), as a pure state machine. The hub feeds it client frames
// (`receive`), topic items (`publish`) and the time (`drain`), and sends the frames it returns.
// There is no I/O and no timer: `drain(now)` also returns `wakeAt`, the time at which a paced
// subscription can send next, and the hub arms its own timer for it.
//
// The hub's loop, on both carriers: after `receive`, `publish` or a timer, call `drain(now)` and
// send `frames`. On transport loss call `park`; on `hello{resume}` call `acceptHello`.
import type { ClientFrame, Problem, Qos, ServerFrame } from '@app/contracts';
import { Credits } from './credits.ts';
import {
  createOutbox,
  type Outbox,
  type OutboxBounds,
  type OutboxOptions,
  type Sized,
  type Take,
} from './outbox.ts';
import { resumeOutbox, type ResumeRegistry } from './resume.ts';

export interface SessionLimits {
  readonly maxSubs: 64;
  /** Bytes held by all outboxes of the session together. */
  readonly outboxBytes: number;
  /** Largest item payload in one frame (a single item above it is never accepted). */
  readonly maxFrameBytes: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = Object.freeze({
  maxSubs: 64,
  outboxBytes: 8 * 1024 * 1024,
  maxFrameBytes: 1024 * 1024,
});

export type SubFrame = Extract<ClientFrame, { t: 'sub' }>;
export type HelloFrame = Extract<ClientFrame, { t: 'hello' }>;

/** What the hub knows about a topic once it has validated a `sub` (a `TopicDef` plus a source). */
export interface SubSpec {
  readonly qos: Qos;
  readonly flow: 'credit' | 'snapshot-delta';
  /** The topic's per-subscription outbox bounds (`TopicDef.ring`). */
  readonly ring: OutboxBounds;
  readonly maxHz?: number;
  readonly sampleEvery?: number;
  /** Identity of an item; `latest` coalesces by it and `snapshot-delta` removes by it. */
  key?(item: unknown): string;
  /** The topic's current full state, read when a snapshot goes out. */
  snapshot(): Sized<readonly unknown[]>;
}

export type SubResolution =
  | { readonly ok: true; readonly spec: SubSpec }
  | { readonly ok: false; readonly problem: Problem };

/** Validates a subscription: topic exists, params parse, the principal may subscribe. */
export type TopicResolver = (sub: SubFrame) => SubResolution;

export interface SessionOptions {
  readonly id: string;
  readonly engineVersion: string;
  readonly resolve: TopicResolver;
  readonly limits?: Partial<SessionLimits>;
}

export type SessionState = 'new' | 'open' | 'draining' | 'detached' | 'closed';

export interface Received {
  readonly frames: ServerFrame[];
  /** Set when the client broke the protocol; the hub closes the transport. */
  readonly violation?: string;
}

export interface Drained {
  readonly frames: ServerFrame[];
  /** When a paced subscription can send next, or null. */
  readonly wakeAt: number | null;
}

export interface SubscriptionView {
  readonly credits: number;
  readonly items: number;
  readonly bytes: number;
  readonly lastSeq: number;
  readonly dropped: number;
}

interface Subscription {
  readonly spec: SubSpec;
  readonly outbox: Outbox;
  readonly credits: Credits;
}

function problem(
  session: string,
  code: Problem['code'],
  status: number,
  title: string,
  detail: string,
  retryable: boolean,
): Problem {
  return {
    type: 'about:blank',
    title,
    status,
    code,
    detail,
    correlationId: session,
    retryable,
  };
}

export class LiveSession {
  readonly id: string;
  readonly limits: SessionLimits;
  readonly #engineVersion: string;
  readonly #resolve: TopicResolver;
  readonly #subs = new Map<number, Subscription>();
  #state: SessionState = 'new';

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.#engineVersion = options.engineVersion;
    this.#resolve = options.resolve;
    this.limits = { ...DEFAULT_SESSION_LIMITS, ...options.limits };
  }

  get state(): SessionState {
    return this.#state;
  }

  get subscriptionCount(): number {
    return this.#subs.size;
  }

  /** Bytes held by every outbox of the session. */
  get outboxBytes(): number {
    let total = 0;
    for (const sub of this.#subs.values()) total += sub.outbox.bytes;
    return total;
  }

  inspect(sid: number): SubscriptionView | undefined {
    const sub = this.#subs.get(sid);
    if (sub === undefined) return undefined;
    return {
      credits: sub.credits.available,
      items: sub.outbox.items,
      bytes: sub.outbox.bytes,
      lastSeq: sub.outbox.lastSeq,
      dropped: sub.outbox.dropped,
    };
  }

  /** Handles one client frame. A `hello{resume}` is routed by `acceptHello` first. */
  receive(frame: ClientFrame): Received {
    switch (frame.t) {
      case 'ping':
        return { frames: [{ t: 'pong', ts: frame.ts }] };
      case 'hello':
        if (this.#state !== 'new') return violation('hello sent twice');
        this.#state = 'open';
        return { frames: [this.#welcome()] };
      default:
        if (this.#state !== 'open' && this.#state !== 'draining') {
          return violation(`${frame.t} outside an open session`);
        }
    }
    switch (frame.t) {
      case 'sub':
        return this.#subscribe(frame);
      case 'credit':
        // A credit for a subscription that just ended is a normal race, not a violation.
        this.#subs.get(frame.sid)?.credits.grant(frame.n);
        return { frames: [] };
      case 'unsub':
        return { frames: this.end(frame.sid, 'unsub') };
    }
  }

  /** Offers a topic item to a subscription. False when the subscription is gone. */
  publish(sid: number, item: Sized<unknown>): boolean {
    const sub = this.#subs.get(sid);
    if (sub === undefined) return false;
    sub.outbox.push(item, sub.spec.key?.(item.value), this.#budget(sub));
    return true;
  }

  /** `snapshot-delta` only: the keyed item is gone. */
  publishRemove(sid: number, key: string): boolean {
    const sub = this.#subs.get(sid);
    if (sub === undefined) return false;
    sub.outbox.remove(key, this.#budget(sub));
    return true;
  }

  /** Ends a subscription from the engine side (or on `unsub`). Nothing when it is unknown. */
  end(
    sid: number,
    reason: Extract<ServerFrame, { t: 'end' }>['reason'],
    cause?: Problem,
  ): ServerFrame[] {
    if (!this.#subs.delete(sid)) return [];
    return [
      cause === undefined
        ? { t: 'end', sid, reason }
        : { t: 'end', sid, reason, problem: cause },
    ];
  }

  /** Asks the client to reconnect; new subscriptions are refused from now on. */
  goaway(
    reason: Extract<ServerFrame, { t: 'goaway' }>['reason'],
    reconnectAfterMs?: number,
  ): ServerFrame {
    if (this.#state === 'open') this.#state = 'draining';
    return reconnectAfterMs === undefined
      ? { t: 'goaway', reason }
      : { t: 'goaway', reason, reconnectAfterMs };
  }

  /**
   * Every frame that credits, pacing and frame size allow right now, and when to call again.
   * A subscription with no credit sends nothing; its items wait in the outbox.
   */
  drain(now: number): Drained {
    const frames: ServerFrame[] = [];
    let wakeAt: number | null = null;
    if (this.#state !== 'open' && this.#state !== 'draining') {
      return { frames, wakeAt };
    }
    for (const [sid, sub] of this.#subs) {
      while (sub.credits.available > 0) {
        const take = sub.outbox.take(now);
        if (take === null) break;
        sub.credits.consume();
        if (!this.#frame(sid, sub, take, frames)) break;
      }
      if (this.#subs.get(sid) !== sub || sub.credits.available === 0) continue;
      const at = sub.outbox.readyAt(now);
      if (at !== null && at > now)
        wakeAt = wakeAt === null ? at : Math.min(wakeAt, at);
    }
    return { frames, wakeAt };
  }

  /** Transport lost: keep the session for the resume window. */
  park(registry: ResumeRegistry<LiveSession>, now: number): void {
    if (this.#state !== 'open' && this.#state !== 'draining') {
      throw new Error(`cannot park a ${this.#state} session`);
    }
    this.#state = 'detached';
    registry.park(this.id, this, now);
  }

  /**
   * The client is back with the sequence numbers it last saw (`hello.resume.lastSeq`, by sid).
   * Credits start again at zero: the client grants after `welcome`.
   */
  resume(lastSeq: Readonly<Record<string, number>>): ServerFrame[] {
    if (this.#state !== 'detached') {
      throw new Error(`cannot resume a ${this.#state} session`);
    }
    this.#state = 'open';
    const frames: ServerFrame[] = [this.#welcome()];
    for (const [sid, sub] of this.#subs) {
      sub.credits.reset();
      resumeOutbox(sub.outbox, lastSeq[String(sid)]);
      frames.push({ t: 'subok', sid, qos: sub.spec.qos });
    }
    return frames;
  }

  close(): void {
    this.#subs.clear();
    this.#state = 'closed';
  }

  #welcome(): ServerFrame {
    return {
      t: 'welcome',
      v: 1,
      session: this.id,
      engineVersion: this.#engineVersion,
      limits: {
        maxSubs: this.limits.maxSubs,
        outboxBytes: this.limits.outboxBytes,
        maxFrameBytes: this.limits.maxFrameBytes,
      },
    };
  }

  #subscribe(frame: SubFrame): Received {
    if (this.#subs.has(frame.sid)) return violation('duplicate sid');
    const refuse = (cause: Problem): Received => ({
      frames: [{ t: 'end', sid: frame.sid, reason: 'error', problem: cause }],
    });
    if (this.#state === 'draining') {
      return refuse(
        problem(
          this.id,
          'ENGINE_SHUTTING_DOWN',
          503,
          'Session is draining',
          'Reconnect and subscribe again.',
          true,
        ),
      );
    }
    if (this.#subs.size >= this.limits.maxSubs) {
      return refuse(
        problem(
          this.id,
          'BUDGET_EXCEEDED',
          429,
          'Too many subscriptions',
          `A session holds at most ${String(this.limits.maxSubs)} subscriptions.`,
          false,
        ),
      );
    }
    const resolved = this.#resolve(frame);
    if (!resolved.ok) return refuse(resolved.problem);
    const spec = resolved.spec;
    const options: OutboxOptions = {
      bounds: spec.ring,
      maxFrameBytes: this.limits.maxFrameBytes,
      flow: spec.flow,
      ...(spec.maxHz === undefined ? {} : { maxHz: spec.maxHz }),
      ...(spec.sampleEvery === undefined
        ? {}
        : { sampleEvery: spec.sampleEvery }),
    };
    this.#subs.set(frame.sid, {
      spec,
      outbox: createOutbox<unknown>(spec.qos, options),
      credits: new Credits(frame.credit),
    });
    return { frames: [{ t: 'subok', sid: frame.sid, qos: spec.qos }] };
  }

  /** What one outbox may hold after a push: its own bound and what the session has left. */
  #budget(sub: Subscription): number {
    return (
      sub.outbox.bytes + Math.max(0, this.limits.outboxBytes - this.outboxBytes)
    );
  }

  /** Turns a take into frames. False when the subscription ended instead. */
  #frame(
    sid: number,
    sub: Subscription,
    take: Take<unknown>,
    out: ServerFrame[],
  ): boolean {
    switch (take.kind) {
      case 'data':
        out.push({
          t: 'data',
          sid,
          seq: take.seq,
          items: take.items,
          ...(take.dropped === undefined ? {} : { dropped: take.dropped }),
          ...(take.sampledEvery === undefined
            ? {}
            : { sampledEvery: take.sampledEvery }),
        });
        return true;
      case 'delta':
        out.push({
          t: 'delta',
          sid,
          seq: take.seq,
          upserts: take.upserts,
          removes: take.removes,
        });
        return true;
      case 'snapshot': {
        const snapshot = sub.spec.snapshot();
        if (snapshot.bytes > this.limits.maxFrameBytes) {
          out.push(
            ...this.end(
              sid,
              'error',
              problem(
                this.id,
                'BUDGET_EXCEEDED',
                413,
                'Snapshot too large',
                `A snapshot of ${String(snapshot.bytes)} bytes exceeds the frame limit.`,
                false,
              ),
            ),
          );
          return false;
        }
        if (take.gap !== undefined) {
          out.push({
            t: 'gap',
            sid,
            fromSeq: take.gap.fromSeq,
            toSeq: take.gap.toSeq,
            reason: take.gap.reason,
          });
        }
        out.push({
          t: 'snapshot',
          sid,
          seq: take.seq,
          items: [...snapshot.value],
        });
        return true;
      }
    }
  }
}

function violation(reason: string): Received {
  return { frames: [], violation: reason };
}

export interface HelloResult extends Received {
  /** The session that now serves the connection: the parked one, or `fresh`. */
  readonly session: LiveSession;
}

/**
 * Routes a `hello`. With `resume` naming a parked session whose window is still open, that session
 * continues; otherwise `fresh` starts a new one and its `welcome` carries a new session id, which
 * tells the client to subscribe again.
 */
export function acceptHello(
  registry: ResumeRegistry<LiveSession>,
  fresh: LiveSession,
  hello: HelloFrame,
  now: number,
): HelloResult {
  const parked =
    hello.resume === undefined
      ? undefined
      : registry.claim(hello.resume.session, now);
  if (parked === undefined || hello.resume === undefined) {
    return { session: fresh, ...fresh.receive(hello) };
  }
  return { session: parked, frames: parked.resume(hello.resume.lastSeq) };
}
