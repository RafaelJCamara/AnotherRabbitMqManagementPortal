// What topology-graph.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createTopologyFakeDeps } from '../testing';
import { createTopologyGraphAction } from './topology-graph';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { cid: 'c1', vhost: '/' };

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createTopologyGraphAction(createTopologyFakeDeps());
}
