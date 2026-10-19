// What settings-put.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createWorkspaceFakeDeps } from '../testing';
import { createSettingsPutAction } from './settings-put';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { settings: { timeDisplay: 'utc' as const } };

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createSettingsPutAction(createWorkspaceFakeDeps());
}
