// What queues-effective-config.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createTopologyFakeDeps } from '../testing';
import { createQueuesEffectiveConfigAction } from './queues-effective-config';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { cid: 'c1', vhost: '/', queue: 'orders.q' };

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createQueuesEffectiveConfigAction(createTopologyFakeDeps());
}
