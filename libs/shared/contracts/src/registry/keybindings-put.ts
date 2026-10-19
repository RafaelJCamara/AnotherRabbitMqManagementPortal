// keybindings.put: replace the caller's keybinding overrides. An empty object clears them all.
import { z } from 'zod';

import { defineAction } from '../kit/define-action.ts';
import { KeybindingOverridesSchema } from './workspace.ts';

export const KeybindingsPutInputSchema = z.strictObject({
  bindings: KeybindingOverridesSchema,
});

export const KeybindingsPutOutputSchema = z.strictObject({});

export const keybindingsPut = defineAction({
  id: 'keybindings.put',
  kind: 'command',
  summary: 'Replace the keybinding overrides',
  input: KeybindingsPutInputSchema,
  output: KeybindingsPutOutputSchema,
  permission: 'workspace.write',
  risk: 'none',
  planning: 'none',
  audit: 'attempt+outcome',
  target: () => ({}),
  http: { method: 'PUT', path: '/keybindings' },
  since: '1.0',
});
