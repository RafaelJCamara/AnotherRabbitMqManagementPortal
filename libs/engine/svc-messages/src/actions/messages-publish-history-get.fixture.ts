// What messages-publish-history-get.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createMessagesPublishHistoryGetAction } from './messages-publish-history-get';
import { createHistoryFixture } from './messages-publish-history.fixture';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { cid: 'c1', entryId: 'entry-1' };

/**
 * The action under test over a fresh history store, with the fixture to record entries into it. The
 * first entry recorded is `entry-1`, which is what `sampleInput` asks for.
 */
export function createSubject() {
  const fixture = createHistoryFixture();
  return {
    ...fixture,
    action: createMessagesPublishHistoryGetAction({ store: fixture.store }),
  };
}
