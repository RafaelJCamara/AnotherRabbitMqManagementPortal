// What topology-subgraph.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createTopologyFakeDeps } from '../testing';
import { createTopologySubgraphAction } from './topology-subgraph';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = {
  cid: 'c1',
  vhost: '/',
  focus: { kind: 'exchange' as const, name: 'orders' },
};

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createTopologySubgraphAction(createTopologyFakeDeps());
}
