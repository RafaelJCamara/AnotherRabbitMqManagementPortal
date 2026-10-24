// The results of @app/routing as the contracts of this module carry them: fresh, mutable arrays, one
// field at a time, so that nothing the library adds later reaches an answer unnamed and TypeScript
// fails the build when a contract and a library drift apart. Lists are bounded here too (I-7): a list
// longer than its contract maximum is cut with the number left out next to it, never silently (I-13).
import {
  LOOP_QUEUES_MAX,
  ROUTING_LIST_MAX,
  type OutputOf,
  type routingDeadLetter,
  type routingDlxSources,
  type routingSimulate,
} from '@app/contracts';
import type {
  DeadLetterPath,
  DeadLetterStep,
  DlxLoop,
  DlxSource,
  DlxTruncation,
  MatchRule,
  PathEnd,
  RouteHop,
  RoutingNote,
  RoutingResult,
  ShareNote,
  UnknownExchange,
  UnknownReason,
} from '@app/routing';

type Simulation = OutputOf<typeof routingSimulate>['result'];
type DeadLetter = OutputOf<typeof routingDeadLetter>;
type Sources = OutputOf<typeof routingDlxSources>;

/** The first `max` items and the number of the rest. */
export function capList<T>(
  items: readonly T[],
  max: number = ROUTING_LIST_MAX,
): { readonly items: T[]; readonly more: number } {
  return {
    items: items.slice(0, max),
    more: Math.max(0, items.length - max),
  };
}

function rule(
  r: MatchRule,
): NonNullable<Simulation['paths'][number]['hops'][number]['rule']> {
  switch (r.kind) {
    case 'default-exchange':
    case 'direct':
      return { kind: r.kind, routingKey: r.routingKey, keySource: r.keySource };
    case 'fanout':
      return { kind: 'fanout' };
    case 'topic':
      return {
        kind: 'topic',
        pattern: r.pattern,
        routingKey: r.routingKey,
        keySource: r.keySource,
      };
    case 'headers':
      return { kind: 'headers', mode: r.mode, arguments: [...r.arguments] };
  }
}

function hop(h: RouteHop): Simulation['paths'][number]['hops'][number] {
  return {
    exchange: h.exchange,
    how: h.how,
    destination: h.destination,
    destinationType: h.destinationType,
    binding:
      h.binding === null
        ? null
        : {
            source: h.binding.source,
            destination: h.binding.destination,
            destinationType: h.binding.destinationType,
            routingKey: h.binding.routingKey,
          },
    rule: h.rule === null ? null : rule(h.rule),
  };
}

export function noteView(n: RoutingNote): Simulation['notes'][number] {
  return {
    code: n.code,
    ...(n.exchange === undefined ? {} : { exchange: n.exchange }),
    ...(n.detail === undefined ? {} : { detail: n.detail }),
  };
}

function unknownExchangeView(
  u: UnknownExchange,
): Simulation['unknownExchanges'][number] {
  return {
    exchange: u.exchange,
    type: u.type,
    hint: u.hint,
    alternateExchange: u.alternateExchange,
  };
}

/**
 * The simulator's answer. `noGaps` is false when something the answer rests on could not be read:
 * the answer is then not exact and not "unroutable", whatever the library says about the topology it
 * was given.
 */
export function simulationView(r: RoutingResult, noGaps: boolean): Simulation {
  return {
    outcome: r.outcome,
    fate: r.fate,
    unroutable: r.unroutable && noGaps,
    queues: [...r.queues],
    paths: r.paths.map((p) => ({ queue: p.queue, hops: p.hops.map(hop) })),
    usedAE: r.usedAE,
    exact: r.exact && noGaps,
    refusal: r.refusal === null ? null : { ...r.refusal },
    unknownExchanges: r.unknownExchanges.map(unknownExchangeView),
    loops: r.loops.map((l) => ({ exchanges: [...l.exchanges] })),
    reachedExchanges: [...r.reachedExchanges],
    keys: {
      routingKey: r.keys.routingKey,
      cc: [...r.keys.cc],
      bcc: [...r.keys.bcc],
    },
    notes: r.notes.map(noteView),
    truncation: { ...r.truncation },
  };
}

export const dlxTruncationView = (
  t: DlxTruncation,
): DeadLetter['truncation'] => ({
  sources: t.sources,
  steps: t.steps,
  paths: t.paths,
  loops: t.loops,
  candidates: t.candidates,
});

function shareView(
  s: ShareNote,
): DeadLetter['paths'][number]['steps'][number]['shares'][number] {
  return {
    code: s.code,
    exchange: s.exchange,
    candidates: [...s.candidates],
    exchangeDestinations: [...s.exchangeDestinations],
    truncated: s.truncated,
  };
}

function stepView(
  s: DeadLetterStep,
): DeadLetter['paths'][number]['steps'][number] {
  return {
    from: s.from,
    reasons: [...s.reasons],
    exchange: s.exchange,
    keys: s.keys === 'original' ? 'original' : [...s.keys],
    exact: s.exact,
    targets: s.targets.map((t) => ({
      queue: t.queue,
      certainty: t.certainty,
      via: [...t.via],
    })),
    dropped: [...s.dropped],
    strategy: s.strategy,
    unknownExchanges: s.unknownExchanges.map(unknownExchangeView),
    shares: s.shares.map(shareView),
    notes: s.notes.map(noteView),
  };
}

function endView(e: PathEnd): DeadLetter['paths'][number]['end'] {
  switch (e.kind) {
    case 'terminal':
    case 'dropped-no-dead-letter':
    case 'dropped-cycle':
    case 'truncated':
      return { kind: e.kind, queue: e.queue };
    case 'dropped-unroutable':
    case 'dropped-missing-exchange':
      return { kind: e.kind, exchange: e.exchange };
    case 'indeterminate':
      return { kind: 'indeterminate', queue: e.queue, why: e.why };
  }
}

export function deadLetterPathView(
  p: DeadLetterPath,
): DeadLetter['paths'][number] {
  return { steps: p.steps.map(stepView), end: endView(p.end) };
}

export function loopView(l: DlxLoop): DeadLetter['loops'][number] {
  const queues = capList(l.queues, LOOP_QUEUES_MAX);
  return {
    queues: queues.items,
    queuesMore: queues.more,
    kind: l.kind,
    possible: l.possible,
  };
}

export function sourceView(s: DlxSource): Sources['sources'][number] {
  return {
    queue: s.queue,
    limit:
      s.limit.kind === 'finite'
        ? { kind: 'finite', value: s.limit.value }
        : { kind: s.limit.kind },
    certainty: s.certainty,
    via: [...s.via],
    reasons: [...s.reasons],
  };
}

export function unknownReasonView(
  u: UnknownReason,
): Sources['unknownReasons'][number] {
  return u.subject === undefined
    ? { code: u.code }
    : { code: u.code, subject: u.subject };
}
