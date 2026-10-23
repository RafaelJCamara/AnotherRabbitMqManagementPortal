// The routing simulator (M1-02, TOP-02). `simulate(topology, publish)` walks the exchanges the way
// the broker's `rabbit_exchange:route1/4` does (RS@v4.3.6:deps/rabbit/src/rabbit_exchange.erl
// L419-476, the same in v3.13.7): a worklist of exchanges, each expanded once; an exchange's
// alternate exchange joins the walk only when the exchange's own destination list is empty; queues
// are collected into a set. The walk here is breadth-first so the first path to an exchange is a
// shortest one; the SET of queues does not depend on the order.
//
// Pure and total: it never throws for input of the right shape. Everything the broker would do
// that the simulator cannot compute (a plugin exchange type) or chose not to (a limit) is said in
// the result, never guessed (R4, R5, I-6, I-13).
import { alternateExchangeFor, alternateExchangeOf } from './ae.ts';
import { routingKeysOf } from './cc-bcc.ts';
import type { KeyedKey } from './cc-bcc.ts';
import { DEFAULT_EXCHANGE, routeDefault } from './default-exchange.ts';
import { directRule } from './direct.ts';
import { compareNames, findLoops, indexTopology } from './e2e.ts';
import type { Edge, TopologyIndex } from './e2e.ts';
import { modelledType, unknownHint } from './exchange-types.ts';
import { fanoutRule } from './fanout.ts';
import { headersRule, parseXMatch } from './headers.ts';
import { topicRule } from './topic.ts';
import { DEFAULT_LIMITS } from './types.ts';
import type {
  Fate,
  LoopReport,
  MatchRule,
  NoteCode,
  Outcome,
  PublishInput,
  Refusal,
  RouteHop,
  RoutePath,
  RoutingKeys,
  RoutingNote,
  RoutingResult,
  RoutingTopology,
  SimulationLimits,
  TopologyBinding,
  Truncation,
  UnknownExchange,
} from './types.ts';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function resolveLimits(given: Partial<SimulationLimits>): SimulationLimits {
  const limits: Mutable<SimulationLimits> = { ...DEFAULT_LIMITS };
  for (const name of Object.keys(
    DEFAULT_LIMITS,
  ) as (keyof SimulationLimits)[]) {
    const value = given[name];
    if (value !== undefined && Number.isFinite(value) && value >= 0) {
      limits[name] = Math.floor(value);
    }
  }
  return limits;
}

interface Match {
  readonly binding: TopologyBinding;
  readonly rule: MatchRule;
}

interface Visit {
  readonly name: string;
  readonly depth: number;
  /** The hops from the published exchange to this exchange. */
  readonly via: readonly RouteHop[];
}

const NO_KEYS = (routingKey: string): RoutingKeys => ({
  routingKey,
  cc: [],
  bcc: [],
});

function isIndex(
  value: RoutingTopology | TopologyIndex,
): value is TopologyIndex {
  return 'bindingsBySource' in value;
}

/**
 * Which queues receive a copy of `publish`, by which paths. `topology` may be the result of
 * `indexTopology` to reuse the index across publishes. `limits` override `DEFAULT_LIMITS`.
 */
export function simulate(
  topology: RoutingTopology | TopologyIndex,
  publish: PublishInput,
  limits: Partial<SimulationLimits> = {},
): RoutingResult {
  const index = isIndex(topology) ? topology : indexTopology(topology);
  const max = resolveLimits(limits);
  const truncation: Mutable<Truncation> = {
    depth: 0,
    exchanges: 0,
    bindings: 0,
    queues: 0,
    paths: 0,
    loops: 0,
    topicWords: 0,
    notes: 0,
  };

  const notes: RoutingNote[] = [];
  const noteKeys = new Set<string>();
  const note = (code: NoteCode, exchange?: string, detail?: string): void => {
    const key = `${code}\u0000${exchange ?? ''}\u0000${detail ?? ''}`;
    if (noteKeys.has(key)) return;
    noteKeys.add(key);
    if (notes.length >= max.maxNotes) {
      truncation.notes += 1;
      return;
    }
    notes.push({
      code,
      ...(exchange === undefined ? {} : { exchange }),
      ...(detail === undefined ? {} : { detail }),
    });
  };

  for (const name of index.duplicateExchanges) note('duplicate-exchange', name);
  if (index.ignoredDefaultBindings > 0) {
    note(
      'ignored-default-exchange-binding',
      DEFAULT_EXCHANGE,
      String(index.ignoredDefaultBindings),
    );
  }

  const finish = (parts: {
    refusal: Refusal | null;
    keys: RoutingKeys;
    paths: Map<string, RoutePath[]>;
    usedAE: boolean;
    unknownExchanges: UnknownExchange[];
    loops: LoopReport[];
    reached: string[];
  }): RoutingResult => {
    for (const [limit, count] of Object.entries(truncation)) {
      // `notes` is the cut of the note list itself; it cannot be noted.
      if (limit !== 'notes' && count > 0) note('truncated', undefined, limit);
    }
    const queues = [...parts.paths.keys()].sort(compareNames);
    const paths = queues.flatMap((queue) => parts.paths.get(queue) ?? []);
    const exact =
      parts.refusal !== null ||
      (parts.unknownExchanges.length === 0 &&
        truncation.depth === 0 &&
        truncation.exchanges === 0 &&
        truncation.bindings === 0 &&
        truncation.queues === 0 &&
        truncation.topicWords === 0);
    let outcome: Outcome;
    let fate: Fate;
    if (parts.refusal !== null) {
      outcome = 'refused';
      fate = 'refused';
    } else if (queues.length > 0) {
      outcome = 'routed';
      fate = 'delivered';
    } else if (exact) {
      outcome = 'unroutable';
      fate = publish.mandatory === true ? 'returned' : 'dropped';
    } else {
      outcome = 'indeterminate';
      fate = 'unknown';
    }
    return {
      outcome,
      fate,
      unroutable: outcome === 'unroutable',
      queues,
      paths,
      usedAE: parts.usedAE,
      exact,
      refusal: parts.refusal,
      unknownExchanges: parts.unknownExchanges,
      loops: parts.loops,
      reachedExchanges: parts.reached,
      keys: parts.keys,
      notes,
      truncation,
    };
  };

  const refused = (refusal: Refusal, keys: RoutingKeys): RoutingResult =>
    finish({
      refusal,
      keys,
      paths: new Map(),
      usedAE: false,
      unknownExchanges: [],
      loops: [],
      reached: [],
    });

  // What the channel checks before it routes: the exchange exists, is not internal, and the
  // message can be built (a CC or BCC header that is not an array fails it).
  const isDefault = publish.exchange === DEFAULT_EXCHANGE;
  const target = isDefault ? undefined : index.exchanges.get(publish.exchange);
  if (!isDefault && target === undefined) {
    return refused(
      { code: 'exchange-not-found', replyCode: 404 },
      NO_KEYS(publish.routingKey),
    );
  }
  if (target?.internal === true) {
    return refused(
      { code: 'internal-exchange', replyCode: 403 },
      NO_KEYS(publish.routingKey),
    );
  }
  const keyed = routingKeysOf(publish.routingKey, publish.headers);
  if (!keyed.ok) {
    return refused(
      {
        code: 'invalid-routing-header',
        replyCode: 406,
        header: keyed.header,
      },
      NO_KEYS(publish.routingKey),
    );
  }
  const keys: readonly KeyedKey[] = keyed.keys;
  if (publish.headers !== undefined && Object.hasOwn(publish.headers, 'BCC')) {
    note('bcc-stripped');
  }

  const paths = new Map<string, RoutePath[]>();
  const addPath = (queue: string, hops: readonly RouteHop[]): void => {
    const list = paths.get(queue);
    if (list === undefined) {
      if (paths.size >= max.maxQueues) {
        truncation.queues += 1;
        return;
      }
      paths.set(queue, [{ queue, hops }]);
    } else if (list.length >= max.maxPathsPerQueue) {
      truncation.paths += 1;
    } else {
      list.push({ queue, hops });
    }
  };

  // The default exchange: no bindings, no alternate exchange.
  if (isDefault) {
    for (const route of routeDefault(keys, index.queues)) {
      addPath(route.queue, [
        {
          exchange: DEFAULT_EXCHANGE,
          how: 'default-exchange',
          destination: route.queue,
          destinationType: 'queue',
          binding: null,
          rule: {
            kind: 'default-exchange',
            routingKey: route.key,
            keySource: route.source,
          },
        },
      ]);
    }
    return finish({
      refusal: null,
      keys: keyed.parts,
      paths,
      usedAE: false,
      unknownExchanges: [],
      loops: [],
      reached: [DEFAULT_EXCHANGE],
    });
  }

  const seen = new Set<string>([publish.exchange]);
  const cutDepth = new Set<string>();
  const cutExchanges = new Set<string>();
  const edges: Edge[] = [];
  const reached: string[] = [];
  const unknownExchanges: UnknownExchange[] = [];
  const hasExtraKeys = keyed.parts.cc.length + keyed.parts.bcc.length > 0;
  let scanned = 0;
  let usedAE = false;

  const work: Visit[] = [{ name: publish.exchange, depth: 0, via: [] }];
  // Appending while iterating is the queue of a breadth-first walk.
  for (const visit of work) {
    const exchange = index.exchanges.get(visit.name);
    if (exchange === undefined) continue; // only existing exchanges are queued
    reached.push(visit.name);

    const type = modelledType(exchange.type);
    if (type === null) {
      unknownExchanges.push({
        exchange: visit.name,
        type: exchange.type,
        hint: unknownHint(exchange.type),
        alternateExchange: alternateExchangeOf(exchange),
      });
      continue;
    }
    if (hasExtraKeys && (type === 'fanout' || type === 'headers')) {
      note('keys-ignored', visit.name);
    }

    // The exchange's own destinations.
    const bindings = index.bindingsBySource.get(visit.name) ?? [];
    const matches: Match[] = [];
    let cutHere = false;
    for (const [position, binding] of bindings.entries()) {
      if (scanned >= max.maxBindingsScanned) {
        cutHere = true;
        truncation.bindings += bindings.length - position;
        break;
      }
      scanned += 1;
      let rule: MatchRule | null = null;
      if (type === 'direct') {
        rule = directRule(binding, keys);
      } else if (type === 'fanout') {
        rule = fanoutRule();
      } else if (type === 'topic') {
        const outcome = topicRule(binding, keys, max.maxTopicWords);
        if (outcome.tooLong) truncation.topicWords += 1;
        rule = outcome.rule;
      } else {
        if (!parseXMatch(binding.arguments).valid) {
          note('invalid-x-match', visit.name, binding.destination);
        }
        rule = headersRule(binding, publish.headers);
      }
      if (rule !== null) matches.push({ binding, rule });
    }

    const hops: RouteHop[] = matches.map(({ binding, rule }) => ({
      exchange: visit.name,
      how: 'binding',
      destination: binding.destination,
      destinationType: binding.destinationType,
      binding: {
        source: binding.source,
        destination: binding.destination,
        destinationType: binding.destinationType,
        routingKey: binding.routingKey,
      },
      rule,
    }));

    // The alternate exchange joins only when the exchange's own list is empty. When the scan was
    // cut the list may not be empty, so it is not followed (the result is a lower bound).
    const ae = cutHere ? null : alternateExchangeFor(matches.length, exchange);
    if (ae !== null) {
      usedAE = true;
      hops.push({
        exchange: visit.name,
        how: 'alternate-exchange',
        destination: ae,
        destinationType: 'exchange',
        binding: null,
        rule: null,
      });
    }

    for (const hop of hops) {
      const path = [...visit.via, hop];
      if (hop.destinationType === 'queue') {
        if (index.queues.has(hop.destination)) addPath(hop.destination, path);
        else note('dangling-destination', visit.name, hop.destination);
        continue;
      }
      if (!index.exchanges.has(hop.destination)) {
        note('missing-exchange', visit.name, hop.destination);
        continue;
      }
      edges.push({ from: visit.name, to: hop.destination });
      if (seen.has(hop.destination)) continue;
      if (visit.depth + 1 > max.maxDepth) {
        cutDepth.add(hop.destination);
        continue;
      }
      if (work.length >= max.maxExchanges) {
        cutExchanges.add(hop.destination);
        continue;
      }
      seen.add(hop.destination);
      work.push({ name: hop.destination, depth: visit.depth + 1, via: path });
    }
  }
  truncation.depth = cutDepth.size;
  truncation.exchanges = cutExchanges.size;

  const found = findLoops(edges);
  truncation.loops = Math.max(0, found.length - max.maxLoops);
  const loops: LoopReport[] = found
    .slice(0, max.maxLoops)
    .map((exchanges) => ({ exchanges }));

  return finish({
    refusal: null,
    keys: keyed.parts,
    paths,
    usedAE,
    unknownExchanges,
    loops,
    reached,
  });
}
