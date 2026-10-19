// What diagnostics-bundle.spec.ts runs. Edit this file, not the spec, as the action grows.
import { FAKE_FILE_TOKEN, createOpsFakeDeps } from '../testing';
import { createDiagnosticsBundleAction } from './diagnostics-bundle';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { fileToken: FAKE_FILE_TOKEN };

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createDiagnosticsBundleAction(createOpsFakeDeps());
}
