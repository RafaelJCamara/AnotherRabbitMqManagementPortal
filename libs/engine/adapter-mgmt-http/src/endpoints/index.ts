// The catalogue of endpoints the adapter knows. `matchEndpoint` is how the client finds the paging,
// columns and stats rules for a request path.
import { operatorPolicies, permissions, policies, users } from './access.ts';
import { channels, connections, consumers } from './clients.ts';
import {
  deprecatedFeatures,
  deprecatedFeaturesUsed,
  featureFlags,
  nodes,
} from './cluster.ts';
import type { EndpointSpec } from './define.ts';
import { definitions, health } from './health.ts';
import { extensions, overview, whoami } from './overview.ts';
import { queueGet, queues } from './queues.ts';
import { bindings, exchanges, vhosts } from './topology.ts';

export {
  defineEndpoint,
  defineList,
  fillTemplate,
  getRequest,
  type EndpointSpec,
} from './define.ts';
export { operatorPolicies, permissions, policies, users } from './access.ts';
export { channels, connections, consumers } from './clients.ts';
export {
  deprecatedFeatures,
  deprecatedFeaturesUsed,
  featureFlags,
  nodes,
} from './cluster.ts';
export { definitions, health } from './health.ts';
export { extensions, overview, whoami } from './overview.ts';
export { queueGet, queues } from './queues.ts';
export { bindings, exchanges, vhosts } from './topology.ts';

/** Every endpoint, for the golden fixtures (M0-25) and for `matchEndpoint`. */
export const ENDPOINTS: readonly EndpointSpec[] = [
  overview,
  whoami,
  extensions,
  nodes,
  featureFlags,
  deprecatedFeatures,
  deprecatedFeaturesUsed,
  ...Object.values(queues),
  queueGet,
  ...Object.values(exchanges),
  ...Object.values(bindings),
  ...Object.values(vhosts),
  ...Object.values(connections),
  ...Object.values(channels),
  ...Object.values(consumers),
  ...Object.values(policies),
  ...Object.values(operatorPolicies),
  ...Object.values(users),
  ...Object.values(permissions),
  ...Object.values(health),
  ...Object.values(definitions),
];

/** The endpoint a path (relative to the API root, without the query) belongs to, if any. */
export function matchEndpoint(path: string): EndpointSpec | undefined {
  return ENDPOINTS.find((spec) => spec.pattern.test(path));
}
