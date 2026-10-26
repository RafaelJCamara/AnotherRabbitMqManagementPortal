// What messages-publish-history-list.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createMessagesPublishHistoryListAction } from './messages-publish-history-list';
import { createHistoryFixture } from './messages-publish-history.fixture';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { cid: 'c1' };

/** The action under test over a fresh history store, with the fixture to record entries into it. */
export function createSubject() {
  const fixture = createHistoryFixture();
  return {
    ...fixture,
    action: createMessagesPublishHistoryListAction({ store: fixture.store }),
  };
}
