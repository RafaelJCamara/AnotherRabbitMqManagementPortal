// Dead-letter routing and paths (M1-03, R4). A queue that dead-letters a message publishes it to its
// dead-letter exchange, which routes it like any publish (`simulate`, flagged as made by the
// broker). Then the broker removes the targets the message has already died in, unless the death
// is a rejection. The walk here follows the chain through queues that dead-letter again.
//
// The cycle rule (RS@v4.3.6:deps/rabbit/src/rabbit_dead_letter.erl `detect_cycles/3` and
// deps/rabbit/src/mc.erl `is_death_cycle/2`, `is_cycle_v2/2`, the same in v3.13.7): the death being
// recorded counts; if its reason is `rejected` nothing is removed; otherwise a target is removed
// when it is among the deaths and every death from the newest back to its latest one is not a
// rejection. Because only the run of non-rejected deaths since the last rejection matters, the
// state of the walk is (queue, queues in that run), not the whole history (OQ-1310: the old v1
// record format is not modelled).
//
// Keys (rabbit_dead_letter:publish/5): a fixed `x-dead-letter-routing-key` is the only key; without
// one the message keeps its own, which a topology does not know unless the caller gives them. Open
// keys are answered with a may-reach over-approximation (OQ-1304): every binding of a key-driven
// exchange is a candidate, marked `possible`.
import { alternateExchangeOf } from './ae.ts';
import { DEFAULT_EXCHANGE } from './default-exchange.ts';
import { compareNames, indexTopology } from './e2e.ts';
import type { TopologyIndex } from './e2e.ts';
import { modelledType, unknownHint } from './exchange-types.ts';
import { shareNoteFor } from './hash-random-notes.ts';
import type { ShareNote } from './hash-random-notes.ts';
import { simulate } from './simulate.ts';
import { deadLetterReasons } from './ttl.ts';
import { DEFAULT_DLX_LIMITS, DEFAULT_LIMITS } from './types.ts';
import type {
  DeadLetterReason,
  DlxLimits,
  DlxTruncation,
  RoutingNote,
  RoutingTopology,
  SimulationLimits,
  TopologyQueue,
  UnknownExchange,
} from './types.ts';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type DlxLimitOptions = Partial<SimulationLimits & DlxLimits>;

export interface DeadLetterIndex {
  readonly routing: TopologyIndex;
  /** Queues by name; a name listed twice keeps its first entry. */
  readonly queues: ReadonlyMap<string, TopologyQueue>;
}

export function indexDeadLetters(
  topology: RoutingTopology | DeadLetterIndex,
): DeadLetterIndex {
  if ('routing' in topology) return topology;
  const queues = new Map<string, TopologyQueue>();
  for (const queue of topology.queues) {
    if (!queues.has(queue.name)) queues.set(queue.name, queue);
  }
  return { routing: indexTopology(topology), queues };
}

export interface ResolvedDlxLimits extends SimulationLimits, DlxLimits {}

export function resolveDlxLimits(
  given: DlxLimitOptions = {},
): ResolvedDlxLimits {
  const out: Mutable<ResolvedDlxLimits> = {
    ...DEFAULT_LIMITS,
    ...DEFAULT_DLX_LIMITS,
  };
  for (const name of Object.keys(out) as (keyof ResolvedDlxLimits)[]) {
    const value = given[name];
    if (value !== undefined && Number.isFinite(value) && value >= 0) {
      out[name] = Math.floor(value);
    }
  }
  return out;
}

export function newDlxTruncation(): Mutable<DlxTruncation> {
  return { sources: 0, steps: 0, paths: 0, loops: 0, candidates: 0 };
}

/** A queue a dead letter can reach. `definite` holds only when the walk could not do otherwise. */
export interface DeadLetterTarget {
  readonly queue: string;
  readonly certainty: 'definite' | 'possible';
  /** The exchanges of the first path found, from the dead-letter exchange on (OQ-1306). */
  readonly via: readonly string[];
}

/** Where one dead letter from one queue is routed, before the cycle rule. */
export interface RoutedDeadLetter {
  readonly exchange: string;
  /** The keys used: the fixed key, the keys the caller gave, or the message's own (unknown). */
  readonly keys: readonly string[] | 'original';
  /** The keys the message has after this hop (null: unknown). */
  readonly nextKeys: readonly string[] | null;
  readonly exact: boolean;
  /** The dead-letter exchange does not exist; the broker drops the message. */
  readonly missingExchange: boolean;
  /** Open keys on the default exchange: any queue may be the target. */
  readonly anyQueue: boolean;
  /**
   * A limit cut the route (or the simulation was refused unexpectedly), so `targets` is a lower
   * bound and a queue missing from it may still be reached. Counted in the truncation too.
   */
  readonly cut: boolean;
  /** Sorted by queue name. */
  readonly targets: readonly DeadLetterTarget[];
  readonly unknownExchanges: readonly UnknownExchange[];
  readonly shares: readonly ShareNote[];
  readonly notes: readonly RoutingNote[];
  readonly strategy: 'at-most-once' | 'at-least-once' | null;
}

export type DeadLetterRouting =
  | { readonly kind: 'no-dead-letter' }
  | { readonly kind: 'unknown-setting' }
  | { readonly kind: 'routed'; readonly routed: RoutedDeadLetter };

interface Candidate {
  queue: string;
  definite: boolean;
  via: readonly string[];
}

function addCandidate(
  into: Map<string, Candidate>,
  queue: string,
  definite: boolean,
  via: readonly string[],
): void {
  const have = into.get(queue);
  if (have === undefined) into.set(queue, { queue, definite, via });
  else if (definite && !have.definite) have.definite = true;
}

function toTargets(from: ReadonlyMap<string, Candidate>): DeadLetterTarget[] {
  return [...from.values()]
    .sort((a, b) => compareNames(a.queue, b.queue))
    .map((c) => ({
      queue: c.queue,
      certainty: c.definite ? 'definite' : 'possible',
      via: c.via,
    }));
}

interface Reach {
  readonly candidates: Map<string, Candidate>;
  readonly unknownExchanges: UnknownExchange[];
  readonly shares: ShareNote[];
  readonly notes: RoutingNote[];
  exact: boolean;
  cut: boolean;
}

/** The queues a dead letter may reach when its keys are open: every binding of a key-driven exchange. */
function mayReach(
  index: DeadLetterIndex,
  start: string,
  limits: ResolvedDlxLimits,
  acc: Mutable<DlxTruncation>,
): Reach {
  const reach: Reach = {
    candidates: new Map(),
    unknownExchanges: [],
    shares: [],
    notes: [],
    exact: true,
    cut: false,
  };
  interface Node {
    name: string;
    via: readonly string[];
    sure: boolean;
  }
  const nodes: Node[] = [{ name: start, via: [start], sure: true }];
  const seen = new Set<string>([start]);
  let scanned = 0;
  // `for...of` over an array visits the nodes pushed during the loop.
  for (const node of nodes) {
    const exchange = index.routing.exchanges.get(node.name);
    if (exchange === undefined) {
      reach.notes.push({ code: 'missing-exchange', exchange: node.name });
      continue;
    }
    const type = modelledType(exchange.type);
    if (type === null) {
      reach.exact = false;
      reach.unknownExchanges.push({
        exchange: exchange.name,
        type: exchange.type,
        hint: unknownHint(exchange.type),
        alternateExchange: alternateExchangeOf(exchange),
      });
      const share = shareNoteFor(
        index.routing,
        exchange,
        limits.maxDlxCandidates,
      );
      if (share !== null) {
        reach.shares.push(share);
        acc.candidates += share.truncated;
        for (const queue of share.candidates) {
          addCandidate(reach.candidates, queue, false, node.via);
        }
      }
      continue;
    }
    const sure = node.sure && type === 'fanout';
    const bindings = index.routing.bindingsBySource.get(node.name) ?? [];
    for (const binding of bindings) {
      scanned += 1;
      if (scanned > limits.maxBindingsScanned) {
        acc.steps += 1;
        reach.exact = false;
        reach.cut = true;
        break;
      }
      if (binding.destinationType === 'queue') {
        if (index.routing.queues.has(binding.destination)) {
          addCandidate(reach.candidates, binding.destination, sure, node.via);
        } else {
          reach.notes.push({
            code: 'dangling-destination',
            exchange: node.name,
            detail: binding.destination,
          });
        }
      } else if (!seen.has(binding.destination)) {
        if (seen.size >= limits.maxExchanges) {
          acc.steps += 1;
          reach.exact = false;
          reach.cut = true;
          continue;
        }
        seen.add(binding.destination);
        nodes.push({
          name: binding.destination,
          via: [...node.via, binding.destination],
          sure,
        });
      }
    }
    const alternate = alternateExchangeOf(exchange);
    if (alternate !== null && !seen.has(alternate)) {
      if (seen.size >= limits.maxExchanges) {
        acc.steps += 1;
        reach.exact = false;
        reach.cut = true;
      } else {
        seen.add(alternate);
        // The alternate exchange is used only when the exchange's own list is empty.
        nodes.push({
          name: alternate,
          via: [...node.via, alternate],
          sure: node.sure && bindings.length === 0,
        });
      }
    }
  }
  for (const candidate of reach.candidates.values()) {
    if (!candidate.definite) reach.exact = false;
  }
  return reach;
}

/**
 * Where a dead letter from `queue` is routed, before the cycle rule. `known` are the message's
 * routing keys when the caller has them (publish key, CC and BCC); null means open.
 */
export function routeDeadLetter(
  index: DeadLetterIndex,
  queue: TopologyQueue,
  known: readonly string[] | null,
  limits: ResolvedDlxLimits,
  acc: Mutable<DlxTruncation>,
): DeadLetterRouting {
  const setting = queue.deadLetter;
  if (setting === undefined) return { kind: 'no-dead-letter' };
  if (setting.status === 'unknown') return { kind: 'unknown-setting' };

  const exchange = setting.exchange;
  const strategy = setting.strategy ?? null;
  const fixed =
    typeof setting.routingKey === 'string' ? [setting.routingKey] : null;
  const keys = fixed ?? (known !== null && known.length > 0 ? known : null);
  const nextKeys = fixed ?? known;

  const missing =
    exchange !== DEFAULT_EXCHANGE && !index.routing.exchanges.has(exchange);
  if (missing) {
    return {
      kind: 'routed',
      routed: {
        exchange,
        keys: keys ?? 'original',
        nextKeys,
        exact: true,
        missingExchange: true,
        anyQueue: false,
        cut: false,
        targets: [],
        unknownExchanges: [],
        shares: [],
        notes: [{ code: 'missing-exchange', exchange }],
        strategy,
      },
    };
  }

  if (keys !== null) {
    const [first = '', ...rest] = keys;
    const result = simulate(
      index.routing,
      {
        exchange,
        routingKey: first,
        ...(rest.length > 0 ? { headers: { CC: rest } } : {}),
        fromBroker: true,
      },
      limits,
    );
    const candidates = new Map<string, Candidate>();
    for (const path of result.paths) {
      addCandidate(
        candidates,
        path.queue,
        true,
        path.hops.map((hop) => hop.exchange),
      );
    }
    const shares: ShareNote[] = [];
    for (const unknown of result.unknownExchanges) {
      const share = shareNoteFor(
        index.routing,
        { name: unknown.exchange, type: unknown.type },
        limits.maxDlxCandidates,
      );
      if (share === null) continue;
      shares.push(share);
      acc.candidates += share.truncated;
      for (const candidate of share.candidates) {
        addCandidate(candidates, candidate, false, [unknown.exchange]);
      }
    }
    // Only the cuts that can hide a queue count; cut paths, loops and notes lose no queue.
    const cut =
      result.refusal !== null ||
      result.truncation.depth +
        result.truncation.exchanges +
        result.truncation.bindings +
        result.truncation.queues +
        result.truncation.topicWords >
        0;
    if (cut) acc.steps += 1;
    return {
      kind: 'routed',
      routed: {
        exchange,
        keys,
        nextKeys,
        exact: result.exact && result.refusal === null,
        missingExchange: false,
        anyQueue: false,
        cut,
        targets: toTargets(candidates),
        unknownExchanges: result.unknownExchanges,
        shares,
        notes: result.notes,
        strategy,
      },
    };
  }

  // Open keys.
  if (exchange === DEFAULT_EXCHANGE) {
    // The default exchange routes by key to the queue of that name: with no key known, any queue.
    return {
      kind: 'routed',
      routed: {
        exchange,
        keys: 'original',
        nextKeys,
        exact: false,
        missingExchange: false,
        anyQueue: true,
        cut: false,
        targets: [],
        unknownExchanges: [],
        shares: [],
        notes: [],
        strategy,
      },
    };
  }
  const reach = mayReach(index, exchange, limits, acc);
  return {
    kind: 'routed',
    routed: {
      exchange,
      keys: 'original',
      nextKeys,
      exact: reach.exact,
      missingExchange: false,
      anyQueue: false,
      cut: reach.cut,
      targets: toTargets(reach.candidates),
      unknownExchanges: reach.unknownExchanges,
      shares: reach.shares,
      notes: reach.notes,
      strategy,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

/** One death and where it sent the message. */
export interface DeadLetterStep {
  readonly from: string;
  /** The reasons this step stands for: all non-rejected ones together, or `rejected` alone. */
  readonly reasons: readonly DeadLetterReason[];
  readonly exchange: string;
  readonly keys: readonly string[] | 'original';
  readonly exact: boolean;
  /** Delivered: routed and not removed by the cycle rule. */
  readonly targets: readonly DeadLetterTarget[];
  /** Routed but removed by the cycle rule (sorted). */
  readonly dropped: readonly string[];
  readonly strategy: 'at-most-once' | 'at-least-once' | null;
  readonly unknownExchanges: readonly UnknownExchange[];
  readonly shares: readonly ShareNote[];
  readonly notes: readonly RoutingNote[];
}

export type PathEnd =
  /** The last queue does not dead-letter any further. */
  | { readonly kind: 'terminal'; readonly queue: string }
  /** The start queue has no dead-letter exchange: what dies there is dropped. */
  | { readonly kind: 'dropped-no-dead-letter'; readonly queue: string }
  /** Every target was removed by the cycle rule. */
  | { readonly kind: 'dropped-cycle'; readonly queue: string }
  /** The dead-letter exchange routes nowhere. */
  | { readonly kind: 'dropped-unroutable'; readonly exchange: string }
  /** The dead-letter exchange does not exist. */
  | { readonly kind: 'dropped-missing-exchange'; readonly exchange: string }
  | {
      readonly kind: 'indeterminate';
      readonly queue: string;
      readonly why:
        | 'dead-letter-unknown'
        | 'unknown-exchange'
        | 'open-default-exchange'
        | 'cut';
    }
  /** The step budget ran out before this queue was expanded. */
  | { readonly kind: 'truncated'; readonly queue: string };

export interface DeadLetterPath {
  readonly steps: readonly DeadLetterStep[];
  readonly end: PathEnd;
}

export interface DeadLetterPathOptions {
  /** The reason of the first death; default: every reason the start queue has. */
  readonly reason?: DeadLetterReason;
  /** The message's routing keys when known (publish key, CC and BCC). */
  readonly keys?: readonly string[];
  readonly limits?: DlxLimitOptions;
}

export interface DeadLetterPathResult {
  readonly startFound: boolean;
  readonly paths: readonly DeadLetterPath[];
  /** Queues that can receive a dead letter on some chain, sorted. */
  readonly reached: readonly string[];
  /** False when a step is a may-reach, an exchange is unknown or a limit cut the walk. */
  readonly exact: boolean;
  readonly notes: readonly RoutingNote[];
  readonly truncation: DlxTruncation;
}

interface WalkNode {
  readonly queue: string;
  /** Queues that died since the last rejection, the current run (see the header). */
  readonly run: ReadonlySet<string>;
  readonly keys: readonly string[] | null;
  readonly parent: WalkNode | null;
  /** The step that delivered the message here; null for the start. */
  readonly step: DeadLetterStep | null;
}

interface DeathClass {
  readonly rejected: boolean;
  readonly reasons: readonly DeadLetterReason[];
}

function classesOf(reasons: readonly DeadLetterReason[]): DeathClass[] {
  const classes: DeathClass[] = [];
  const automatic = reasons.filter((reason) => reason !== 'rejected');
  if (automatic.length > 0)
    classes.push({ rejected: false, reasons: automatic });
  if (reasons.includes('rejected')) {
    classes.push({ rejected: true, reasons: ['rejected'] });
  }
  return classes;
}

function stateKey(
  queue: string,
  run: ReadonlySet<string>,
  keys: readonly string[] | null,
): string {
  return `${queue}\u0000${[...run].sort(compareNames).join('\u0001')}\u0000${
    keys === null ? '*' : keys.join('\u0001')
  }`;
}

function chain(node: WalkNode): DeadLetterStep[] {
  const steps: DeadLetterStep[] = [];
  for (let at: WalkNode | null = node; at !== null; at = at.parent) {
    if (at.step !== null) steps.push(at.step);
  }
  return steps.reverse();
}

/**
 * Where a message that dies in `from` goes, and where it goes after that. One path per end of
 * the chain; the first path to a queue is a shortest one. With `options.reason` the first death
 * has that reason; otherwise every reason of the start queue is tried.
 */
export function deadLetterPath(
  topology: RoutingTopology | DeadLetterIndex,
  from: string,
  options: DeadLetterPathOptions = {},
): DeadLetterPathResult {
  const index = indexDeadLetters(topology);
  const limits = resolveDlxLimits(options.limits);
  const acc = newDlxTruncation();
  const startQueue = index.queues.get(from);
  if (startQueue === undefined) {
    return {
      startFound: false,
      paths: [],
      reached: [],
      exact: false,
      notes: [{ code: 'dangling-destination', detail: from }],
      truncation: acc,
    };
  }

  const keys0 =
    options.keys !== undefined && options.keys.length > 0 ? options.keys : null;
  const start: WalkNode = {
    queue: from,
    run: new Set(),
    keys: keys0,
    parent: null,
    step: null,
  };
  const frontier: WalkNode[] = [start];
  const visited = new Set<string>([stateKey(from, start.run, keys0)]);
  const reached = new Set<string>();
  const notes: RoutingNote[] = [];
  const noteKeys = new Set<string>();
  const leaves: {
    node: WalkNode;
    last: DeadLetterStep | null;
    end: PathEnd;
  }[] = [];
  let exact = true;
  let expansions = 0;

  for (const node of frontier) {
    const queue = index.queues.get(node.queue);
    if (queue === undefined) continue;
    const isStart = node === start;

    if (expansions >= limits.maxDlxSteps) {
      acc.steps += 1;
      exact = false;
      leaves.push({
        node,
        last: null,
        end: { kind: 'truncated', queue: node.queue },
      });
      continue;
    }

    if (queue.deadLetter === undefined) {
      leaves.push({
        node,
        last: null,
        end: isStart
          ? { kind: 'dropped-no-dead-letter', queue: node.queue }
          : { kind: 'terminal', queue: node.queue },
      });
      continue;
    }

    const classes =
      isStart && options.reason !== undefined
        ? classesOf([options.reason])
        : classesOf(deadLetterReasons(queue));
    if (classes.length === 0) {
      if (!isStart) {
        leaves.push({
          node,
          last: null,
          end: { kind: 'terminal', queue: node.queue },
        });
      }
      continue;
    }

    const routing = routeDeadLetter(index, queue, node.keys, limits, acc);
    if (routing.kind === 'no-dead-letter') continue;
    if (routing.kind === 'unknown-setting') {
      exact = false;
      leaves.push({
        node,
        last: null,
        end: {
          kind: 'indeterminate',
          queue: node.queue,
          why: 'dead-letter-unknown',
        },
      });
      continue;
    }
    const routed = routing.routed;
    expansions += 1;
    if (!routed.exact) exact = false;
    for (const note of routed.notes) {
      const key = `${note.code}\u0000${note.exchange ?? ''}\u0000${note.detail ?? ''}`;
      if (!noteKeys.has(key)) {
        noteKeys.add(key);
        notes.push(note);
      }
    }

    for (const cls of classes) {
      const run = cls.rejected
        ? new Set<string>()
        : new Set<string>([...node.run, node.queue]);
      // A rejection is never a cycle; otherwise a target in the current run is removed.
      const delivered = routed.targets.filter(
        (target) => cls.rejected || !run.has(target.queue),
      );
      const dropped = routed.targets
        .filter((target) => !cls.rejected && run.has(target.queue))
        .map((target) => target.queue);
      const step: DeadLetterStep = {
        from: node.queue,
        reasons: cls.reasons,
        exchange: routed.exchange,
        keys: routed.keys,
        exact: routed.exact,
        targets: delivered,
        dropped,
        strategy: routed.strategy,
        unknownExchanges: routed.unknownExchanges,
        shares: routed.shares,
        notes: routed.notes,
      };

      if (routed.anyQueue) {
        leaves.push({
          node,
          last: step,
          end: {
            kind: 'indeterminate',
            queue: node.queue,
            why: 'open-default-exchange',
          },
        });
        continue;
      }
      if (routed.missingExchange) {
        leaves.push({
          node,
          last: step,
          end: { kind: 'dropped-missing-exchange', exchange: routed.exchange },
        });
        continue;
      }
      if (delivered.length === 0) {
        let end: PathEnd;
        if (dropped.length > 0) {
          end = { kind: 'dropped-cycle', queue: node.queue };
        } else if (routed.exact) {
          end = { kind: 'dropped-unroutable', exchange: routed.exchange };
        } else {
          end = {
            kind: 'indeterminate',
            queue: node.queue,
            why:
              routed.unknownExchanges.length > 0 ? 'unknown-exchange' : 'cut',
          };
        }
        leaves.push({ node, last: step, end });
        continue;
      }
      for (const target of delivered) {
        reached.add(target.queue);
        const key = stateKey(target.queue, run, routed.nextKeys);
        if (visited.has(key)) continue;
        visited.add(key);
        frontier.push({
          queue: target.queue,
          run,
          keys: routed.nextKeys,
          parent: node,
          step,
        });
      }
    }
  }

  const paths: DeadLetterPath[] = [];
  for (const leaf of leaves) {
    if (paths.length >= limits.maxDlxPaths) {
      acc.paths += 1;
      exact = false;
      continue;
    }
    const steps = chain(leaf.node);
    if (leaf.last !== null) steps.push(leaf.last);
    paths.push({ steps, end: leaf.end });
    if (leaf.end.kind === 'indeterminate' || leaf.end.kind === 'truncated') {
      exact = false;
    }
  }

  return {
    startFound: true,
    paths,
    reached: [...reached].sort(compareNames),
    exact: exact && acc.steps === 0 && acc.paths === 0 && acc.candidates === 0,
    notes,
    truncation: acc,
  };
}
