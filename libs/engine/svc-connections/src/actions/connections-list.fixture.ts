// What connections-list.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createConnectionsFakeDeps } from '../testing';
import { createConnectionsListAction } from './connections-list';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = {};

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createConnectionsListAction(createConnectionsFakeDeps());
}
