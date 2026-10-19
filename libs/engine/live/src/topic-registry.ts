// The topics the hub can serve (blueprint 3.5, ADR-005). A service declares a topic once with
// `defineTopic` and registers it here with a `TopicSource`: how to read its current state and how
// to follow it. The hub never knows what a topic means; it validates the subscription, feeds the
// source's items to the session's outbox and ends the source when the subscription ends.
import type { Problem, TopicDef, TopicId } from '@app/contracts';
import type { Principal } from '@app/ports';
import type { Sized } from '@app/live-protocol';
import type { z } from 'zod';

/** Where a source puts what it produces. Every call is for one subscription. */
export interface TopicSink<I> {
  /** Offers an item. `bytes` is its encoded size; the hub measures it when it is left out. */
  publish(item: I, bytes?: number): void;
  /** `snapshot-delta` topics: the keyed item is gone. */
  remove(key: string): void;
  /** The topic is over (`completed`), or failed (with a Problem). The subscription ends. */
  end(problem?: Problem): void;
}

export interface TopicSource<P, I> {
  /** The topic's full current state, read whenever a snapshot goes out. Bounded by the caller. */
  snapshot(params: P, principal: Principal): Sized<readonly I[]>;
  /** Starts following the topic; the returned function stops it. Called once per subscription. */
  subscribe(params: P, principal: Principal, sink: TopicSink<I>): () => void;
}

export interface RegisteredTopic {
  readonly def: TopicDef;
  readonly source: TopicSource<unknown, unknown>;
}

export interface TopicRegistry {
  /** Registers a topic once; a second registration of the same id throws. */
  register<P extends z.ZodType, T extends z.ZodType>(
    def: TopicDef<P, T>,
    source: TopicSource<z.infer<P>, z.infer<T>>,
  ): void;
  lookup(id: TopicId): RegisteredTopic | undefined;
  readonly size: number;
}

export function createTopicRegistry(): TopicRegistry {
  const topics = new Map<string, RegisteredTopic>();
  return {
    register(def, source) {
      if (topics.has(def.id)) {
        throw new Error(`Topic ${def.id} is already registered.`);
      }
      if (def.flow === 'snapshot-delta' && def.key === undefined) {
        throw new Error(`Topic ${def.id} is snapshot-delta and needs a key().`);
      }
      topics.set(def.id, {
        def,
        source: source,
      });
    },
    lookup: (id) => topics.get(id),
    get size() {
      return topics.size;
    },
  };
}
