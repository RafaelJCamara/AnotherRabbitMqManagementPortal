// What bundles-import.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createConnectionsFakeDeps } from '../testing';
import { createBundlesImportAction } from './bundles-import';

/** A bundle as an export makes it: addresses and user names, no secret. */
export const sampleBundle = {
  format: 'connection-bundle' as const,
  version: 1 as const,
  exportedAt: 1_000,
  secretsIncluded: false as const,
  profiles: [
    {
      name: 'Imported broker',
      envClass: 'staging' as const,
      color: null,
      http: {
        host: 'mq.example',
        port: 15671,
        tls: true,
        pathPrefix: null,
        auth: { kind: 'basic' as const, username: 'orders-user' },
      },
      amqp: {
        host: 'mq.example',
        port: 5671,
        tls: true,
        vhost: '/prod',
        auth: { kind: 'plain' as const, username: 'orders-user' },
      },
    },
  ],
};

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { bundle: sampleBundle };

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createBundlesImportAction(createConnectionsFakeDeps());
}
