// What connections-create.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createConnectionsFakeDeps } from '../testing';
import { createConnectionsCreateAction } from './connections-create';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = {
  name: 'Orders broker',
  envClass: 'dev' as const,
  uri: 'amqps://orders-user:orders-pass@mq.example:5671/%2Fprod',
};

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createConnectionsCreateAction(createConnectionsFakeDeps());
}
