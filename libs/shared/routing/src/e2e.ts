// Exchange-to-exchange support (M1-02, R2 and R6): the topology index the walk reads, and the loop
// pass over the edges the walk took. The walk itself is in simulate.ts.
import type {
  RoutingTopology,
  TopologyBinding,
  TopologyExchange,
} from './types.ts';

export interface TopologyIndex {
  /** Exchanges by name; a name listed twice keeps its first entry. */
  readonly exchanges: ReadonlyMap<string, TopologyExchange>;
  readonly queues: ReadonlySet<string>;
  /** Bindings by source exchange, in input order. */
  readonly bindingsBySource: ReadonlyMap<string, readonly TopologyBinding[]>;
  /** Exchange names listed more than once. */
  readonly duplicateExchanges: readonly string[];
  /** Bindings whose source is the default exchange (it has none; they are ignored). */
  readonly ignoredDefaultBindings: number;
}

/** One pass over the topology. Reusable for any number of publishes. */
export function indexTopology(topology: RoutingTopology): TopologyIndex {
  const exchanges = new Map<string, TopologyExchange>();
  const duplicateExchanges: string[] = [];
  for (const exchange of topology.exchanges) {
    if (exchanges.has(exchange.name)) duplicateExchanges.push(exchange.name);
    else exchanges.set(exchange.name, exchange);
  }
  const queues = new Set<string>();
  for (const queue of topology.queues) queues.add(queue.name);
  const bindingsBySource = new Map<string, TopologyBinding[]>();
  let ignoredDefaultBindings = 0;
  for (const binding of topology.bindings) {
    if (binding.source === '') {
      ignoredDefaultBindings += 1;
      continue;
    }
    const list = bindingsBySource.get(binding.source);
    if (list === undefined) bindingsBySource.set(binding.source, [binding]);
    else list.push(binding);
  }
  return {
    exchanges,
    queues,
    bindingsBySource,
    duplicateExchanges,
    ignoredDefaultBindings,
  };
}

export interface Edge {
  readonly from: string;
  readonly to: string;
}

interface LoopNode {
  readonly name: string;
  readonly children: string[];
  order: number;
  low: number;
  onStack: boolean;
}

export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The loops among the edges: every strongly connected component with more than one exchange, and
 * every exchange with an edge to itself. Each loop is its exchanges, sorted; loops are sorted by
 * their first exchange. Iterative (Tarjan), so a long chain cannot overflow the stack.
 */
export function findLoops(edges: readonly Edge[]): string[][] {
  const nodes = new Map<string, LoopNode>();
  const selfLoops = new Set<string>();
  const nodeOf = (name: string): LoopNode => {
    let node = nodes.get(name);
    if (node === undefined) {
      node = { name, children: [], order: -1, low: -1, onStack: false };
      nodes.set(name, node);
    }
    return node;
  };
  for (const { from, to } of edges) {
    nodeOf(from).children.push(to);
    nodeOf(to);
    if (from === to) selfLoops.add(from);
  }

  const stack: LoopNode[] = [];
  const loops: string[][] = [];
  let counter = 0;
  const open = (node: LoopNode): { node: LoopNode; child: number } => {
    node.order = counter;
    node.low = counter;
    counter += 1;
    stack.push(node);
    node.onStack = true;
    return { node, child: 0 };
  };

  for (const start of [...nodes.values()]) {
    if (start.order >= 0) continue;
    const frames = [open(start)];
    for (
      let frame = frames.at(-1);
      frame !== undefined;
      frame = frames.at(-1)
    ) {
      const { node } = frame;
      const toName = node.children[frame.child];
      if (toName !== undefined) {
        frame.child += 1;
        const to = nodeOf(toName);
        if (to.order < 0) frames.push(open(to));
        else if (to.onStack) node.low = Math.min(node.low, to.order);
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined) {
        parent.node.low = Math.min(parent.node.low, node.low);
      }
      if (node.low === node.order) {
        const members: string[] = [];
        for (
          let member = stack.pop();
          member !== undefined;
          member = stack.pop()
        ) {
          member.onStack = false;
          members.push(member.name);
          if (member === node) break;
        }
        if (members.length > 1 || selfLoops.has(node.name)) {
          loops.push(members.sort(compareNames));
        }
      }
    }
  }
  return loops.sort((a, b) => compareNames(a[0] ?? '', b[0] ?? ''));
}
