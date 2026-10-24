// What routing-simulate.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createTopologyFakeDeps } from '../testing';
import { createRoutingSimulateAction } from './routing-simulate';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = {
  cid: 'c1',
  vhost: '/',
  exchange: 'orders',
  routingKey: 'order.created',
};

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createRoutingSimulateAction(createTopologyFakeDeps());
}
