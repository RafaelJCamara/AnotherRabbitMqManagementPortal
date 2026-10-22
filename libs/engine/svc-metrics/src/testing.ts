// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit). Give each port in deps.ts a fake here.
import { AppError } from '@app/kernel';

import type { MetricsModuleDeps } from './deps';

/** Ports that know nothing: no connection, no profile, and a broker that cannot be reached. */
export function createMetricsFakeDeps(): MetricsModuleDeps {
  const unreachable = (): Promise<never> =>
    Promise.reject(new AppError('BROKER_UNREACHABLE'));
  return {
    prom: { read: unreachable },
    mgmt: { get: unreachable, stream: unreachable },
    profiles: { get: () => Promise.resolve(undefined) },
    connections: { get: () => Promise.resolve(undefined) },
  };
}
