// The delivery counters a message may carry next to its deaths: `x-delivery-count` (quorum queues,
// stamped after a message was returned), `x-acquired-count` and, for 1.0, the `delivery-count` of
// the header section. A counter is a non-negative integer; anything else is null and flagged. They
// are read as sent: a copy made by a client survives into the next delivery (framework research
// C1), which is why they carry no more trust than the history does.
import type { MessageParts } from './entries.ts';
import { field, readInteger, type ReadContext } from './read.ts';
import type { Counter, DeathCounters, HistoryFlag } from './types.ts';

/** The first container that has the header; undefined when none has. */
export function lookupNamed(
  ctx: ReadContext,
  containers: readonly unknown[],
  name: string,
): unknown {
  for (const container of containers) {
    const value = field(ctx, container, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function counter(
  ctx: ReadContext,
  raw: unknown,
  source: string,
  flags: Set<HistoryFlag>,
  provenance: string[],
): Counter | null {
  provenance.push(source);
  const value = readInteger(ctx, raw);
  if (value === null || value < 0) {
    flags.add('counter-invalid');
    return null;
  }
  return { value, source };
}

export function readCounters(
  ctx: ReadContext,
  parts: MessageParts,
  flags: Set<HistoryFlag>,
  provenance: string[],
): DeathCounters {
  const delivery = lookupNamed(ctx, parts.named, 'x-delivery-count');
  const header = field(ctx, parts.amqpHeader, 'delivery-count');
  const acquired = lookupNamed(ctx, parts.named, 'x-acquired-count');
  return {
    deliveryCount:
      delivery !== undefined
        ? counter(ctx, delivery, 'x-delivery-count', flags, provenance)
        : header !== undefined
          ? counter(ctx, header, 'header.delivery-count', flags, provenance)
          : null,
    acquiredCount:
      acquired === undefined
        ? null
        : counter(ctx, acquired, 'x-acquired-count', flags, provenance),
  };
}
