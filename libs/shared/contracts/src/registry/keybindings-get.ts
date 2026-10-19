// keybindings.get: the caller's keybinding overrides (the defaults belong to the UI).
import { z } from 'zod';

import { defineAction } from '../kit/define-action.ts';
import { KeybindingOverridesSchema } from './workspace.ts';

export const KeybindingsGetInputSchema = z.strictObject({});

export const KeybindingsGetOutputSchema = z.strictObject({
  bindings: KeybindingOverridesSchema,
});

export const keybindingsGet = defineAction({
  id: 'keybindings.get',
  kind: 'query',
  summary: 'Read the keybinding overrides of the caller',
  input: KeybindingsGetInputSchema,
  output: KeybindingsGetOutputSchema,
  permission: 'workspace.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  http: { method: 'GET', path: '/keybindings' },
  since: '1.0',
});
