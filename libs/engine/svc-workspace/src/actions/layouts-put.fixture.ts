// What layouts-put.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createWorkspaceFakeDeps } from '../testing';
import { createLayoutsPutAction } from './layouts-put';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = {
  cid: 'c1',
  layout: { panels: ['explorer', 'tap'] },
};

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createLayoutsPutAction(createWorkspaceFakeDeps());
}
