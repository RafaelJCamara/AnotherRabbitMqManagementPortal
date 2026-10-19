// What connections-get.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createConnectionsFakeDeps } from '../testing';
import { createConnectionsGetAction } from './connections-get';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { cid: 'c1' };

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createConnectionsGetAction(createConnectionsFakeDeps());
}
