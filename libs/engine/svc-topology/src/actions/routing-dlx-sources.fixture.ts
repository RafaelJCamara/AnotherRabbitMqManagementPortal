// What routing-dlx-sources.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createTopologyFakeDeps } from '../testing';
import { createRoutingDlxSourcesAction } from './routing-dlx-sources';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { cid: 'c1', vhost: '/', queue: 'orders.dlq' };

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createRoutingDlxSourcesAction(createTopologyFakeDeps());
}
