// What keybindings-put.spec.ts runs. Edit this file, not the spec, as the action grows.
import { createWorkspaceFakeDeps } from '../testing';
import { createKeybindingsPutAction } from './keybindings-put';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { bindings: { 'go-to.explorer': 'Alt+1' } };

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createKeybindingsPutAction(createWorkspaceFakeDeps());
}
