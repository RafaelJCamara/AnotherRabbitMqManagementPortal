// Exchanges that pick ONE bound queue per message (M1-03, R6). `x-consistent-hash` hashes the
// routing key (or a header) over the bound queues by weight; `x-random` picks at random. The
// simulator cannot predict the pick, so it reports the choice as a note and lists the candidates,
// never a chosen queue. The behaviour is from the plugin documentation (OQ-1308); M1-02 already
// keeps these exchanges out of the walk and reports them unknown.
import { compareNames, type TopologyIndex } from './e2e.ts';
import { unknownHint } from './exchange-types.ts';
import type { RoutingNote, TopologyExchange } from './types.ts';

export interface ShareNote {
  readonly code: 'non-deterministic-share' | 'random-destination';
  readonly exchange: string;
  /** Existing queues bound to the exchange, sorted, without duplicates, bounded. */
  readonly candidates: readonly string[];
  /** Bound exchanges (the plugin picks among queues; these are listed, not followed). */
  readonly exchangeDestinations: readonly string[];
  /** Candidates not listed because of the limit (counted, never silent). */
  readonly truncated: number;
}

/**
 * The note for an exchange of a hash or random type, or null for any other type. Reads the
 * bindings of the exchange once.
 */
export function shareNoteFor(
  index: TopologyIndex,
  exchange: Pick<TopologyExchange, 'name' | 'type'>,
  maxCandidates: number,
): ShareNote | null {
  const hint = unknownHint(exchange.type);
  if (
    hint !== 'hash-single-destination' &&
    hint !== 'random-single-destination'
  ) {
    return null;
  }

  const queues = new Set<string>();
  const exchanges = new Set<string>();
  for (const binding of index.bindingsBySource.get(exchange.name) ?? []) {
    if (binding.destinationType === 'exchange') {
      exchanges.add(binding.destination);
    } else if (index.queues.has(binding.destination)) {
      queues.add(binding.destination);
    }
  }
  const sorted = [...queues].sort(compareNames);
  const cap = Math.max(0, maxCandidates);
  return {
    code:
      hint === 'hash-single-destination'
        ? 'non-deterministic-share'
        : 'random-destination',
    exchange: exchange.name,
    candidates: sorted.slice(0, cap),
    exchangeDestinations: [...exchanges].sort(compareNames),
    truncated: Math.max(0, sorted.length - cap),
  };
}

/** The same note as a routing note: a code and the number of candidates, no prose. */
export function toRoutingNote(share: ShareNote): RoutingNote {
  return {
    code: share.code,
    exchange: share.exchange,
    detail: String(share.candidates.length + share.truncated),
  };
}
