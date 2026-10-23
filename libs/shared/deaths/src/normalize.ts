// The death history of one message: the records of either protocol as one list (entries.ts), the
// first/last headers and their cross-check (first-last.ts), the counters (counters.ts) and the
// trust verdict (trust.ts), with the bounds and the counts of everything that was cut. It never
// throws and never reads a header outside the fixed list of names, so nothing else of the message
// (and none of its body, which is not an input) can reach the output.
import { readCounters } from './counters.ts';
import {
  closingFlags,
  collectEntries,
  messageParts,
  truncationOf,
} from './entries.ts';
import { crossCheck, readFirstLast } from './first-last.ts';
import { newContext } from './read.ts';
import { assessTrust, findMarkers } from './trust.ts';
import type {
  DeathContext,
  DeathCounters,
  DeathHistory,
  DeathMessage,
  HistoryFlag,
} from './types.ts';

const NO_COUNTERS: DeathCounters = { deliveryCount: null, acquiredCount: null };

function sumCounts(
  counts: readonly (number | null)[],
  flags: Set<HistoryFlag>,
): number | null {
  let total = 0;
  for (const count of counts) {
    if (count === null) return null;
    total += count;
    if (!Number.isSafeInteger(total)) {
      flags.add('total-overflow');
      return null;
    }
  }
  return counts.length === 0 ? null : total;
}

export function normalizeDeaths(
  message: DeathMessage,
  context: DeathContext,
): DeathHistory {
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
      first: null,
      last: null,
      totalDeaths: null,
      counters: NO_COUNTERS,
      trust: assessTrust({
        interpreted: context.clientDeathInterpreted,
        hasHistory: false,
        clientPublished: false,
        markers: { stamps: [], republish: [] },
        flags: new Set(),
      }),
      trusted: false,
    };
  }

  const collected = collectEntries(ctx, parts);
  const flags = collected.flags;
  const provenance = collected.provenance;

  const firstLast = readFirstLast(ctx, parts.deaths);
  provenance.push(...firstLast.names);
  crossCheck(firstLast, collected.entries, ctx.entriesDropped === 0, flags);

  const counters = readCounters(ctx, parts, flags, provenance);

  const markers = findMarkers(ctx, parts);
  provenance.push(...markers.stamps, ...markers.republish);
  if (markers.stamps.length > 0) flags.add('replay-stamp-present');
  if (markers.republish.length > 0) flags.add('republish-marker-present');

  // First/last headers without records: the records were stripped, not absent.
  const state =
    collected.state === 'none' && flags.has('client-stripped')
      ? 'present'
      : collected.state;

  const totalDeaths =
    ctx.entriesDropped > 0
      ? null
      : sumCounts(
          collected.entries.map((entry) => entry.count),
          flags,
        );

  const trust = assessTrust({
    interpreted: context.clientDeathInterpreted,
    hasHistory: collected.entries.length > 0,
    clientPublished: parts.clientPublished,
    markers,
    flags,
  });

  return {
    protocol: parts.protocol,
    state,
    source: collected.source,
    entries: collected.entries,
    orderBasis: collected.orderBasis,
    flags: closingFlags(ctx, flags),
    truncation: truncationOf(ctx),
    provenance,
    first: firstLast.first,
    last: firstLast.last,
    totalDeaths,
    counters,
    trust,
    trusted: trust.trusted,
  };
}
