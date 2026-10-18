// Shared setup of the lease specs: connect options over the fakes. Not part of the package API.
import type { QueueType } from '@app/domain-model';

import type { ConnectOptions } from '../connect.ts';
import type { QueueTypeLookup } from '../leases/peek.ts';
import { FakeDialer, FakeDriver } from './fake-driver.ts';

export const CANARY_PASSWORD = 'canary-secret-p4ssw0rd';

export interface Harness {
  readonly driver: FakeDriver;
  readonly dialer: FakeDialer;
  readonly options: ConnectOptions;
}

export function harness(overrides: Partial<ConnectOptions> = {}): Harness {
  const driver = new FakeDriver();
  const dialer = new FakeDialer();
  return {
    driver,
    dialer,
    options: {
      dialer,
      route: { kind: 'direct' },
      endpoint: { host: 'broker.example', port: 5672 },
      credentials: {
        kind: 'plain',
        username: 'guest',
        password: CANARY_PASSWORD,
      },
      name: { product: 'product', mode: 'local', session: 's1' },
      driver,
      now: () => 1_700_000_000_000,
      operationTimeoutMs: 1_000,
      ...overrides,
    },
  };
}

export function queueTypes(types: Record<string, QueueType>): QueueTypeLookup {
  return { typeOf: (queue) => types[queue] };
}

export const classicQueues: QueueTypeLookup = {
  typeOf: () => 'classic',
};
