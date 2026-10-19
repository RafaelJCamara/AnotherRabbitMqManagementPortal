// settings.get: the effective workspace settings of the caller (stored values over the defaults).
import { z } from 'zod';

import { defineAction } from '../kit/define-action.ts';
import { WorkspaceSettingsSchema } from './workspace.ts';

export const SettingsGetInputSchema = z.strictObject({});

export const SettingsGetOutputSchema = z.strictObject({
  settings: WorkspaceSettingsSchema,
});

export const settingsGet = defineAction({
  id: 'settings.get',
  kind: 'query',
  summary: 'Read the workspace settings of the caller',
  input: SettingsGetInputSchema,
  output: SettingsGetOutputSchema,
  permission: 'workspace.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  http: { method: 'GET', path: '/settings' },
  since: '1.0',
});
