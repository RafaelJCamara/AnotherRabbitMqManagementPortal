// What probe-run.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createCapabilitiesFakeDeps } from '../testing';
import { createProbeRunAction } from './probe-run';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { cid: 'c1' };

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createProbeRunAction(createCapabilitiesFakeDeps());
}
