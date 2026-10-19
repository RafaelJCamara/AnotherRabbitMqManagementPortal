// What views-create.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createWorkspaceFakeDeps } from '../testing';
import { createViewsCreateAction } from './views-create';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = {
  name: 'Busy queues',
  kind: 'queues',
  definition: { filter: 'orders' },
};

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createViewsCreateAction(createWorkspaceFakeDeps());
}
