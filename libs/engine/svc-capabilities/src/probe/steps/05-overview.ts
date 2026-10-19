// Step 5, overview: `GET /api/overview` names the product and its version, the statistics switches,
// the default queue type, the exchange types and the listeners. It is asked several times: a load
// balancer in front of a cluster answers from different nodes, and the node names differ (fact sheet
// j.2 step 5). The first answer is the reference; the others only add node names and versions.
import { read } from '../read';
import { OverviewSchema } from '../schemas';
import type { ProbeStep } from '../types';

/** How many times the overview is asked. Cheap, and enough to meet a second node behind a balancer. */
export const OVERVIEW_ASKS = 3;

export const overviewStep: ProbeStep = {
  id: 'overview',
  async run(env, facts) {
    for (let ask = 0; ask < OVERVIEW_ASKS; ask += 1) {
      try {
        const overview = await read(env, '/api/overview', OverviewSchema);
        facts.overviews.push({ node: overview.node, overview });
      } catch (error) {
        // The first answer is the one the profile cannot do without; a later one is a bonus.
        if (ask === 0) throw error;
        break;
      }
    }
    const nodes = new Set(facts.overviews.map((answer) => answer.node));
    return {
      status: 'ok',
      detail: `${String(facts.overviews.length)} answer(s) from ${String(nodes.size)} node name(s)`,
    };
  },
};
