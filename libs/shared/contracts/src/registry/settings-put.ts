// settings.put: change some workspace settings. The input is the strict schema of the known keys,
// so a key the engine does not know is VALIDATION_FAILED, not a silently stored value.
import { z } from 'zod';

import { defineAction } from '../kit/define-action.ts';
import { WorkspaceSettingsSchema } from './workspace.ts';

export const SettingsPutInputSchema = z.strictObject({
  /** The keys to change; the others keep their value. */
  settings: WorkspaceSettingsSchema.partial(),
});

export const SettingsPutOutputSchema = z.strictObject({
  /** The effective settings after the change. */
  settings: WorkspaceSettingsSchema,
});

export const settingsPut = defineAction({
  id: 'settings.put',
  kind: 'command',
  summary: 'Change workspace settings',
  input: SettingsPutInputSchema,
  output: SettingsPutOutputSchema,
  permission: 'workspace.write',
  risk: 'none',
  planning: 'none',
  audit: 'attempt+outcome',
  target: () => ({}),
  http: { method: 'PUT', path: '/settings' },
  since: '1.0',
});
