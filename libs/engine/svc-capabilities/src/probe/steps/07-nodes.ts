// Step 7, nodes: `GET /api/nodes` with the columns the profile reads. The answer names the nodes,
// whether each runs and which plugins it has enabled (with statistics on). It does not carry a
// version: the lab brokers (3.13.7 to 4.3.6) answer no per-node version here, so a node's version is
// known only when that node itself answered `/api/overview` (OQ-475), and every other node is read
// as unreadable by every rule.
import { read } from '../read';
import { NodesSchema } from '../schemas';
import type { NodeFact, ProbeStep } from '../types';

const MAX_NODES = 100;
const COLUMNS = 'name,running,enabled_plugins,being_drained';

export const nodesStep: ProbeStep = {
  id: 'nodes',
  async run(env, facts) {
    const answer = await read(env, '/api/nodes', NodesSchema, {
      columns: COLUMNS,
    });
    facts.nodes = answer.slice(0, MAX_NODES).map(
      (node): NodeFact => ({
        name: node.name,
        running: node.running ?? false,
        beingDrained: node.being_drained,
        plugins: node.enabled_plugins,
      }),
    );
    return { status: 'ok', detail: `${String(facts.nodes.length)} node(s)` };
  },
};
