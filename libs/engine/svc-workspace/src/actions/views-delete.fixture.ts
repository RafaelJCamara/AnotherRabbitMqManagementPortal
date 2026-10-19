// What views-delete.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createWorkspaceFakeDeps } from '../testing';
import { createViewsDeleteAction } from './views-delete';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { viewId: 'sample' };

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createViewsDeleteAction(
    createWorkspaceFakeDeps({
      views: [
        {
          id: 'sample',
          ownerId: 'user-1', // the principal of createTestPrincipal()
          name: 'Sample',
          kind: 'queues',
          definition: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
  );
}
