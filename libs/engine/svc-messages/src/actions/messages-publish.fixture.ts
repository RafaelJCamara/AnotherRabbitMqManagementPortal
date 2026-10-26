// What messages-publish.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createMessagesFakeDeps } from '../testing';
import { createMessagesPublishAction } from './messages-publish';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = {
  cid: 'c1',
  vhost: '/',
  exchange: '',
  routingKey: 'orders',
  props: { contentType: 'text/plain' },
  body: { encoding: 'utf8' as const, data: 'hello' },
};

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject(
  overrides: Parameters<typeof createMessagesFakeDeps>[0] = {},
) {
  return createMessagesPublishAction(createMessagesFakeDeps(overrides));
}
