// LiveClient: the UI end of the live protocol (ADR-005, blueprint 3.5). One session per UI, opened
// on the first subscription, carried by the EngineTransport (WebSocket or MessagePort, the frames
// are identical). The credit accounting reuses `Credits` from @app/live-protocol, the same class the
// engine session counts with, so both ends agree on the balance by construction.
//
// Credits are granted back after rendering: frames are delivered to subscribers at once, and the
// credit for them goes to the engine in the next animation frame, one `credit` frame per
// subscription. A tab that is not drawing grants nothing, the engine's outboxes fill, and each
// topic's QoS decides what is dropped and counted; nothing backs up into the broker (I-6, I-13).
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import type {
  ClientFrame,
  ItemOf,
  ParamsOf,
  Qos,
  ServerFrame,
  TopicDef,
} from '@app/contracts';
import { Credits } from '@app/live-protocol';
import {
  ENGINE_TRANSPORT,
  TransportError,
  type LiveChannel,
} from '@app/ui-platform';
import { Observable, type Subscriber } from 'rxjs';

import { EngineProblemError, syntheticProblem } from './errors';
import { ENGINE_PARSE } from './parse-mode';

export type GapReason = Extract<ServerFrame, { t: 'gap' }>['reason'];
export type StatusState = Extract<ServerFrame, { t: 'status' }>['state'];
type GoawayFrame = Extract<ServerFrame, { t: 'goaway' }>;

/**
 * What a subscriber sees. `data` appends, `snapshot` replaces everything, `delta` changes keyed
 * items, `gap` says items were lost (a `snapshot` follows), `status` is the topic's health and
 * `reset` says the engine started a new session, so what the subscriber holds is stale.
 */
export type LiveEvent<T> =
  | {
      readonly kind: 'data';
      readonly seq: number;
      readonly items: readonly T[];
      readonly dropped?: number;
      readonly sampledEvery?: number;
    }
  | {
      readonly kind: 'snapshot';
      readonly seq: number;
      readonly items: readonly T[];
    }
  | {
      readonly kind: 'delta';
      readonly seq: number;
      readonly upserts: readonly T[];
      readonly removes: readonly string[];
    }
  | {
      readonly kind: 'gap';
      readonly fromSeq: number;
      readonly toSeq: number;
      readonly reason: GapReason;
    }
  | { readonly kind: 'status'; readonly state: StatusState }
  | { readonly kind: 'reset' };

export type LiveClientState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'down';

export interface LiveSubscribeOptions {
  /** Frames the engine may send before the first credit grant. */
  readonly credit?: number;
}

export interface LiveClientConfig {
  readonly initialCredit: number;
  readonly maxReconnectAttempts: number;
  /** Delay before reconnect attempt number `attempt` (1, 2, ...). */
  readonly reconnectDelayMs: (attempt: number) => number;
  /** Runs `callback` once the frames delivered so far have been rendered. */
  readonly afterRender: (callback: () => void) => void;
  /** Runs `callback` after `ms`; returns a function that cancels it. */
  readonly setTimer: (callback: () => void, ms: number) => () => void;
}

export const DEFAULT_LIVE_CLIENT_CONFIG: LiveClientConfig = {
  initialCredit: 16,
  maxReconnectAttempts: 10,
  reconnectDelayMs: (attempt) =>
    Math.min(8000, 250 * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4),
  afterRender: (callback) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        callback();
      });
    } else {
      setTimeout(callback, 16);
    }
  },
  setTimer: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

export const LIVE_CLIENT_CONFIG = new InjectionToken<LiveClientConfig>(
  'LIVE_CLIENT_CONFIG',
  { providedIn: 'root', factory: () => DEFAULT_LIVE_CLIENT_CONFIG },
);

/** Counters that make loss visible (I-13); a feature can show them in its status. */
export interface LiveClientStats {
  /** Frames the engine sent without credit. The protocol forbids it. */
  readonly creditViolations: number;
  /** Frames dropped because their seq was not newer than the last one delivered. */
  readonly staleFrames: number;
  /** Frames for a subscription that no longer exists. */
  readonly orphanFrames: number;
  /** Items the engine counted as dropped (`data.dropped`), summed. */
  readonly droppedItems: number;
  readonly gaps: number;
  readonly reconnects: number;
}

interface ActiveSub {
  readonly sid: number;
  readonly topic: TopicDef;
  readonly params: unknown;
  readonly initialCredit: number;
  readonly subscriber: Subscriber<LiveEvent<unknown>>;
  credits: Credits;
  /** Frames delivered whose credit has not gone back yet. */
  unrendered: number;
  lastSeq: number;
  /** Whether the engine session of this connection knows the subscription. */
  subscribed: boolean;
  /** Whether a frame arrived in the current session (a new session then needs a `reset`). */
  receivedAny: boolean;
  qos: Qos | undefined;
}

const MAX_SUBS = 64;

@Injectable({ providedIn: 'root' })
export class LiveClient {
  readonly #transport = inject(ENGINE_TRANSPORT);
  readonly #config = inject(LIVE_CLIENT_CONFIG);
  readonly #parse = inject(ENGINE_PARSE);

  readonly #state = signal<LiveClientState>('idle');
  readonly #engineVersion = signal<string | undefined>(undefined);
  readonly #goaway = signal<GoawayFrame | undefined>(undefined);
  readonly state: Signal<LiveClientState> = this.#state.asReadonly();
  /** The engine version of the current session, for the "reload to update" banner. */
  readonly engineVersion: Signal<string | undefined> =
    this.#engineVersion.asReadonly();
  /** The last `goaway` the engine sent. */
  readonly goaway: Signal<GoawayFrame | undefined> = this.#goaway.asReadonly();

  readonly #subs = new Map<number, ActiveSub>();
  /** Subscriptions ended while offline that the engine's parked session may still hold. */
  readonly #pendingUnsubs = new Set<number>();
  readonly #stats = {
    creditViolations: 0,
    staleFrames: 0,
    orphanFrames: 0,
    droppedItems: 0,
    gaps: 0,
    reconnects: 0,
  };
  #nextSid = 1;
  #generation = 0;
  #channel: LiveChannel | undefined;
  #ready = false;
  #sessionId: string | undefined;
  #maxSubs = MAX_SUBS;
  #attempt = 0;
  #cancelTimer: (() => void) | undefined;
  #reconnectDelay: number | undefined;
  #grantScheduled = false;
  #destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroy();
    });
  }

  get stats(): LiveClientStats {
    return { ...this.#stats };
  }

  /**
   * Subscribes to a topic. The Observable is cold: the subscription starts on subscribe and ends
   * on unsubscribe. It completes when the engine ends the subscription and errors with an
   * EngineProblemError when the engine ends it with a Problem, or with a TransportError when the
   * connection cannot be re-established.
   */
  subscribe<T extends TopicDef>(
    topic: T,
    params: ParamsOf<T>,
    options: LiveSubscribeOptions = {},
  ): Observable<LiveEvent<ItemOf<T>>> {
    const credit = options.credit ?? this.#config.initialCredit;
    if (!Number.isInteger(credit) || credit < 1) {
      throw new RangeError('credit must be a positive integer');
    }
    return new Observable<LiveEvent<ItemOf<T>>>((subscriber) => {
      if (this.#destroyed) {
        subscriber.complete();
        return undefined;
      }
      if (this.#subs.size >= this.#maxSubs) {
        subscriber.error(
          new EngineProblemError({
            ...syntheticProblem(429, ''),
            title: 'Too many subscriptions',
            code: 'BUDGET_EXCEEDED',
            retryable: false,
            detail: `A session holds at most ${String(this.#maxSubs)} subscriptions.`,
          }),
        );
        return undefined;
      }
      const sid = this.#nextSid++;
      const sub: ActiveSub = {
        sid,
        topic,
        params,
        initialCredit: credit,
        subscriber: subscriber,
        credits: new Credits(credit),
        unrendered: 0,
        lastSeq: 0,
        subscribed: false,
        receivedAny: false,
        qos: undefined,
      };
      this.#subs.set(sid, sub);
      if (this.#ready) {
        this.#sendSub(sub);
      } else {
        this.#ensureConnected();
      }
      return () => {
        if (this.#subs.delete(sid) && sub.subscribed) {
          if (this.#ready) {
            this.#send({ t: 'unsub', sid });
          } else {
            // Offline: tell the engine after a resume, which keeps the subscription alive.
            this.#pendingUnsubs.add(sid);
          }
        }
      };
    });
  }

  /** Closes the session and completes every subscription. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#generation += 1;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#channel?.close();
    this.#channel = undefined;
    this.#ready = false;
    const subs = [...this.#subs.values()];
    this.#subs.clear();
    for (const sub of subs) sub.subscriber.complete();
    this.#state.set('idle');
  }

  #ensureConnected(): void {
    if (this.#channel === undefined && this.#cancelTimer === undefined) {
      this.#connect();
    }
  }

  #connect(): void {
    this.#state.set(this.#attempt === 0 ? 'connecting' : 'reconnecting');
    const generation = ++this.#generation;
    this.#ready = false;
    let channel: LiveChannel;
    try {
      channel = this.#transport.openLive();
    } catch {
      this.#lost(generation);
      return;
    }
    this.#channel = channel;
    this.#send(this.#hello());
    void this.#pump(channel, generation);
  }

  #hello(): ClientFrame {
    const lastSeq: Record<string, number> = {};
    for (const sub of this.#subs.values()) {
      if (sub.lastSeq > 0) lastSeq[String(sub.sid)] = sub.lastSeq;
    }
    return this.#sessionId === undefined || this.#subs.size === 0
      ? { t: 'hello', v: 1 }
      : { t: 'hello', v: 1, resume: { session: this.#sessionId, lastSeq } };
  }

  async #pump(channel: LiveChannel, generation: number): Promise<void> {
    try {
      for await (const frame of channel.frames()) {
        if (generation !== this.#generation) return;
        this.#onFrame(frame);
      }
    } catch {
      // The carrier broke; that is the same as losing it.
    }
    this.#lost(generation);
  }

  #send(frame: ClientFrame): void {
    try {
      this.#channel?.send(frame);
    } catch {
      // The channel is closed. The pump sees the end and starts the reconnect.
    }
  }

  #sendSub(sub: ActiveSub): void {
    sub.subscribed = true;
    this.#send({
      t: 'sub',
      sid: sub.sid,
      topic: sub.topic.id,
      params: sub.params,
      credit: sub.credits.available,
    });
  }

  #onFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case 'welcome': {
        this.#onWelcome(frame);
        return;
      }
      case 'subok': {
        const sub = this.#subs.get(frame.sid);
        if (sub) sub.qos = frame.qos;
        return;
      }
      case 'data':
      case 'snapshot':
      case 'delta': {
        this.#onItems(frame);
        return;
      }
      case 'status': {
        this.#emit(frame.sid, { kind: 'status', state: frame.state });
        return;
      }
      case 'gap':
        this.#stats.gaps += 1;
        {
          this.#emit(frame.sid, {
            kind: 'gap',
            fromSeq: frame.fromSeq,
            toSeq: frame.toSeq,
            reason: frame.reason,
          });
          return;
        }
      case 'end': {
        this.#onEnd(frame);
        return;
      }
      case 'goaway':
        this.#goaway.set(frame);
        this.#reconnectDelay = frame.reconnectAfterMs;
        this.#channel?.close();
        return;
      case 'pong':
        return;
    }
  }

  #onWelcome(frame: Extract<ServerFrame, { t: 'welcome' }>): void {
    const resumed =
      this.#sessionId !== undefined && frame.session === this.#sessionId;
    this.#sessionId = frame.session;
    this.#maxSubs = frame.limits.maxSubs;
    this.#engineVersion.set(frame.engineVersion);
    this.#ready = true;
    this.#attempt = 0;
    this.#state.set('ready');
    if (resumed) {
      for (const sid of this.#pendingUnsubs) this.#send({ t: 'unsub', sid });
    }
    this.#pendingUnsubs.clear();
    for (const sub of this.#subs.values()) {
      sub.unrendered = 0;
      if (resumed && sub.subscribed) {
        // The engine kept the subscription, but credits restart at zero (the engine hub resets them on resume).
        sub.credits.reset();
        const accepted = sub.credits.grant(sub.initialCredit);
        if (accepted > 0)
          this.#send({ t: 'credit', sid: sub.sid, n: accepted });
      } else {
        if (sub.receivedAny) sub.subscriber.next({ kind: 'reset' });
        sub.credits = new Credits(sub.initialCredit);
        sub.lastSeq = 0;
        sub.receivedAny = false;
        this.#sendSub(sub);
      }
    }
  }

  #onItems(
    frame: Extract<ServerFrame, { t: 'data' | 'snapshot' | 'delta' }>,
  ): void {
    const sub = this.#subs.get(frame.sid);
    if (sub === undefined) {
      this.#stats.orphanFrames += 1;
      return;
    }
    if (sub.credits.available === 0) {
      this.#stats.creditViolations += 1;
    } else {
      sub.credits.consume();
    }
    // The credit of every frame goes back, delivered or not.
    sub.unrendered += 1;
    this.#scheduleGrant();
    // seq is a cursor, not a counter: coalesced and sampled topics skip numbers (OQ-123). A data
    // or delta frame that is not newer than the last one is a replay and is dropped; a snapshot
    // always replaces the state.
    if (frame.t !== 'snapshot' && frame.seq <= sub.lastSeq) {
      this.#stats.staleFrames += 1;
      return;
    }
    let event: LiveEvent<unknown>;
    try {
      event = this.#event(sub, frame);
    } catch (error) {
      this.#subs.delete(sub.sid);
      this.#send({ t: 'unsub', sid: sub.sid });
      sub.subscriber.error(error);
      return;
    }
    sub.lastSeq = frame.seq;
    sub.receivedAny = true;
    sub.subscriber.next(event);
  }

  #event(
    sub: ActiveSub,
    frame: Extract<ServerFrame, { t: 'data' | 'snapshot' | 'delta' }>,
  ): LiveEvent<unknown> {
    const check = (items: readonly unknown[]): readonly unknown[] =>
      this.#parse ? items.map((item) => sub.topic.item.parse(item)) : items;
    switch (frame.t) {
      case 'data':
        if (frame.dropped !== undefined) {
          this.#stats.droppedItems += frame.dropped;
        }
        return {
          kind: 'data',
          seq: frame.seq,
          items: check(frame.items),
          ...(frame.dropped === undefined ? {} : { dropped: frame.dropped }),
          ...(frame.sampledEvery === undefined
            ? {}
            : { sampledEvery: frame.sampledEvery }),
        };
      case 'snapshot':
        return { kind: 'snapshot', seq: frame.seq, items: check(frame.items) };
      case 'delta':
        return {
          kind: 'delta',
          seq: frame.seq,
          upserts: check(frame.upserts),
          removes: frame.removes,
        };
    }
  }

  #emit(sid: number, event: LiveEvent<unknown>): void {
    this.#subs.get(sid)?.subscriber.next(event);
  }

  #onEnd(frame: Extract<ServerFrame, { t: 'end' }>): void {
    const sub = this.#subs.get(frame.sid);
    if (sub === undefined) return;
    this.#subs.delete(frame.sid);
    if (frame.reason === 'unsub' || frame.reason === 'completed') {
      sub.subscriber.complete();
      return;
    }
    sub.subscriber.error(
      new EngineProblemError(
        frame.problem ?? {
          ...syntheticProblem(500, this.#sessionId ?? ''),
          title: `Subscription ended: ${frame.reason}`,
        },
        frame.problem === undefined ? { synthetic: true } : {},
      ),
    );
  }

  /** Returns the credit of the frames delivered so far, once they have been rendered. */
  #scheduleGrant(): void {
    if (this.#grantScheduled) return;
    this.#grantScheduled = true;
    const generation = this.#generation;
    this.#config.afterRender(() => {
      this.#grantScheduled = false;
      if (generation !== this.#generation || !this.#ready) return;
      for (const sub of this.#subs.values()) {
        if (sub.unrendered === 0) continue;
        const accepted = sub.credits.grant(sub.unrendered);
        sub.unrendered = 0;
        if (accepted > 0)
          this.#send({ t: 'credit', sid: sub.sid, n: accepted });
      }
    });
  }

  #lost(generation: number): void {
    if (generation !== this.#generation || this.#destroyed) return;
    this.#channel = undefined;
    this.#ready = false;
    this.#grantScheduled = false;
    if (this.#subs.size === 0) {
      this.#sessionId = undefined;
      this.#attempt = 0;
      this.#state.set('idle');
      return;
    }
    this.#attempt += 1;
    if (this.#attempt > this.#config.maxReconnectAttempts) {
      this.#giveUp();
      return;
    }
    this.#stats.reconnects += 1;
    this.#state.set('reconnecting');
    const delay =
      this.#reconnectDelay ?? this.#config.reconnectDelayMs(this.#attempt);
    this.#reconnectDelay = undefined;
    this.#cancelTimer = this.#config.setTimer(() => {
      this.#cancelTimer = undefined;
      if (this.#destroyed) return;
      if (this.#subs.size === 0) {
        this.#sessionId = undefined;
        this.#attempt = 0;
        this.#state.set('idle');
      } else {
        this.#connect();
      }
    }, delay);
  }

  #giveUp(): void {
    const subs = [...this.#subs.values()];
    this.#subs.clear();
    this.#sessionId = undefined;
    this.#attempt = 0;
    this.#state.set('down');
    const error = new TransportError(
      'closed',
      'The live connection could not be re-established.',
    );
    for (const sub of subs) sub.subscriber.error(error);
  }
}
