// What metrics-query.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createMetricsFakeDeps } from '../testing';
import { createMetricsQueryAction } from './metrics-query';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = {
  cid: 'c1',
  series: [{ metric: 'messages_ready' as const }],
};

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createMetricsQueryAction(createMetricsFakeDeps());
}
