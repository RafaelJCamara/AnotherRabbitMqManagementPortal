// A lease handed to a caller is a new frozen object with exactly the methods of its role, so the
// manager can see when the connection behind it is released and nothing else leaks through
// (ADR-009: a peek never publishes). Every method is listed here; a method added to a port type
// fails to compile until it is forwarded.
import type {
  ObserveLease,
  PeekLease,
  PublishLease,
  SourceLease,
} from '@app/ports';

export function wrapPeek(
  lease: PeekLease,
  release: PeekLease['release'],
): PeekLease {
  return Object.freeze<PeekLease>({
    get: (queue) => lease.get(queue),
    nackRequeue: (upToTag, options) => {
      lease.nackRequeue(upToTag, options);
    },
    qosBarrier: (prefetch) => lease.qosBarrier(prefetch),
    ackWithProof: (tag, proof) => {
      lease.ackWithProof(tag, proof);
    },
    throwaway: (fn) => lease.throwaway(fn),
    release,
  });
}

export function wrapSource(
  lease: SourceLease,
  release: SourceLease['release'],
): SourceLease {
  return Object.freeze<SourceLease>({
    consume: (queue, prefetch, onDelivery) =>
      lease.consume(queue, prefetch, onDelivery),
    ackWithProof: (tag, proof) => {
      lease.ackWithProof(tag, proof);
    },
    nackRequeue: (tag, proof) => {
      lease.nackRequeue(tag, proof);
    },
    qosBarrier: (prefetch) => lease.qosBarrier(prefetch),
    cancel: (consumerTag) => lease.cancel(consumerTag),
    release,
  });
}

export function wrapPublish(
  lease: PublishLease,
  release: PublishLease['release'],
): PublishLease {
  return Object.freeze<PublishLease>({
    publish: (exchange, routingKey, body, props, options) =>
      lease.publish(exchange, routingKey, body, props, options),
    blocked: () => lease.blocked(),
    release,
  });
}

export function wrapObserve(
  lease: ObserveLease,
  release: ObserveLease['release'],
): ObserveLease {
  return Object.freeze<ObserveLease>({
    declareTapQueue: (spec) => lease.declareTapQueue(spec),
    bindQueue: (queue, source, key, args) =>
      lease.bindQueue(queue, source, key, args),
    unbindQueue: (queue, source, key, args) =>
      lease.unbindQueue(queue, source, key, args),
    consume: (queue, prefetch, onDelivery) =>
      lease.consume(queue, prefetch, onDelivery),
    ackTap: (tag, multiple) => {
      lease.ackTap(tag, multiple);
    },
    release,
  });
}
