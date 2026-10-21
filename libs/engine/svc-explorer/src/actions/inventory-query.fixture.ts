// What inventory-query.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createExplorerFakeDeps } from '../testing';
import { createInventoryQueryAction } from './inventory-query';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = {
  cid: 'c1',
  kind: 'queues',
  window: { offset: 0, limit: 200 },
};

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createInventoryQueryAction(createExplorerFakeDeps());
}
