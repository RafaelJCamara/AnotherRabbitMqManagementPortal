// The death records of one message, as one list, newest first, in milliseconds.
//
// The native form is read first (`x-death` for 0-9-1, `x-opt-deaths` for 1.0). The other form in
// the same container is read only when the native one is absent (`foreign-form`), and both being
// present is reported (`both-forms-present`). The order is the broker's: for 0-9-1 it is the
// order of last death, which the `time` field (the first death of a pair) cannot reproduce, so it
// is kept. For 1.0, which carries last-time, a list that is out of order is sorted newest first
// (stable) and reported (`reordered`).
import { readEntry, type DeathForm } from './entry.ts';
import { LIMITS } from './limits.ts';
import { field, newContext, readArray, type ReadContext } from './read.ts';
import type {
  DeathEntry,
  DeathMessage,
  DeathProtocol,
  EntriesResult,
  HistoryFlag,
  HistoryState,
  OrderBasis,
  Truncation,
} from './types.ts';
import { X_DEATH } from './x-death.ts';
import { X_OPT_DEATHS } from './x-opt-deaths.ts';

/** Where a message keeps what this library reads. */
export interface MessageParts {
  readonly protocol: DeathProtocol;
  /** The header table (0-9-1) or the message annotations (1.0): the death arrays live here. */
  readonly deaths: unknown;
  readonly clientPublished: boolean;
}

/** The parts of a message, or null when it names no protocol this library knows. */
export function messageParts(
  ctx: ReadContext,
  message: DeathMessage,
): MessageParts | null {
  try {
    const clientPublished = message.clientPublished === true;
    // A JavaScript caller may send anything; the type is not evidence.
    const protocol: string = message.protocol;
    if (protocol === 'amqp091') {
      const { headers } = message as { headers?: unknown };
      return { protocol: 'amqp091', deaths: headers, clientPublished };
    }
    if (protocol === 'amqp10') {
      const { messageAnnotations } = message as {
        messageAnnotations?: unknown;
      };
      return {
        protocol: 'amqp10',
        deaths: messageAnnotations,
        clientPublished,
      };
    }
  } catch {
    ctx.errors++;
  }
  return null;
}

export interface Collected {
  readonly state: HistoryState;
  readonly source: EntriesResult['source'];
  readonly entries: readonly DeathEntry[];
  readonly orderBasis: OrderBasis;
  readonly flags: Set<HistoryFlag>;
  readonly provenance: string[];
}

function sortNewestFirst(entries: readonly DeathEntry[]): DeathEntry[] {
  return [...entries].sort(
    (a, b) => (b.lastTimeMs ?? 0) - (a.lastTimeMs ?? 0) || a.index - b.index,
  );
}

/** Reads the death records; never throws. The caller turns the context into flags and counts. */
export function collectEntries(
  ctx: ReadContext,
  parts: MessageParts,
): Collected {
  const native: DeathForm =
    parts.protocol === 'amqp091' ? X_DEATH : X_OPT_DEATHS;
  const other: DeathForm = native === X_DEATH ? X_OPT_DEATHS : X_DEATH;
  const flags = new Set<HistoryFlag>();
  const provenance: string[] = [];

  const nativeRaw = field(ctx, parts.deaths, native.name);
  const otherRaw = field(ctx, parts.deaths, other.name);
  let form: DeathForm = native;
  let raw = nativeRaw;
  if (nativeRaw !== undefined && otherRaw !== undefined) {
    flags.add('both-forms-present');
    provenance.push(other.name);
  } else if (nativeRaw === undefined && otherRaw !== undefined) {
    form = other;
    raw = otherRaw;
    flags.add('foreign-form');
  }
  if (raw === undefined) {
    return {
      state: 'none',
      source: null,
      entries: [],
      orderBasis: 'broker-order',
      flags,
      provenance,
    };
  }
  provenance.unshift(form.name);

  const read = readArray(ctx, raw, LIMITS.maxEntries);
  if (read === null) {
    flags.add('death-field-wrong-type');
    return {
      state: 'present',
      source: form.name,
      entries: [],
      orderBasis: 'broker-order',
      flags,
      provenance,
    };
  }
  if (read.total > read.items.length) {
    ctx.entriesDropped += read.total - read.items.length;
  }
  const entries = read.items.map((item, index) =>
    readEntry(ctx, item, index, form),
  );

  const sortable =
    form.lastTime !== null &&
    entries.length > 0 &&
    entries.every((entry) => entry.lastTimeMs !== null);
  let ordered: readonly DeathEntry[] = entries;
  if (sortable) {
    ordered = sortNewestFirst(entries);
    if (ordered.some((entry, position) => entry.index !== position)) {
      flags.add('reordered');
    }
  }
  return {
    state: 'present',
    source: form.name,
    entries: ordered,
    orderBasis: sortable ? 'last-time' : 'broker-order',
    flags,
    provenance,
  };
}

/** What was cut, counted (I-6, I-13). */
export function truncationOf(ctx: ReadContext): Truncation {
  return {
    entriesDropped: ctx.entriesDropped,
    routingKeysDropped: ctx.routingKeysDropped,
    textsTruncated: ctx.textsTruncated,
  };
}

/** The flags every normalisation ends with: what the counters say happened. */
export function closingFlags(
  ctx: ReadContext,
  flags: ReadonlySet<HistoryFlag>,
): HistoryFlag[] {
  const out = new Set(flags);
  if (ctx.errors > 0) out.add('read-error');
  if (
    ctx.entriesDropped > 0 ||
    ctx.routingKeysDropped > 0 ||
    ctx.textsTruncated > 0
  ) {
    out.add('truncated');
  }
  return [...out];
}

/** Only the death records: `normalizeDeaths` adds first/last, counters and the trust verdict. */
export function readDeathEntries(message: DeathMessage): EntriesResult {
  const ctx = newContext();
  const parts = messageParts(ctx, message);
  if (parts === null) {
    return {
      protocol: 'amqp091',
      state: 'unreadable',
      source: null,
      entries: [],
      orderBasis: 'broker-order',
      flags: closingFlags(ctx, new Set<HistoryFlag>(['read-error'])),
      truncation: truncationOf(ctx),
      provenance: [],
    };
  }
  const collected = collectEntries(ctx, parts);
  return {
    protocol: parts.protocol,
    state: collected.state,
    source: collected.source,
    entries: collected.entries,
    orderBasis: collected.orderBasis,
    flags: closingFlags(ctx, collected.flags),
    truncation: truncationOf(ctx),
    provenance: collected.provenance,
  };
}
