// What connections-update.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createConnectionsFakeDeps } from '../testing';
import { createConnectionsUpdateAction } from './connections-update';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { cid: 'c1', name: 'Renamed' };

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createConnectionsUpdateAction(createConnectionsFakeDeps());
}
