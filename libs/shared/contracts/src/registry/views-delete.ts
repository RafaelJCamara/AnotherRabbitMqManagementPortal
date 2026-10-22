// views.delete: delete one of the caller's saved views.
import { z } from 'zod';

import { defineAction } from '../kit/define-action.ts';

export const ViewsDeleteInputSchema = z.strictObject({
  viewId: z.string().min(1).max(64),
});

export const ViewsDeleteOutputSchema = z.strictObject({});

export const viewsDelete = defineAction({
  id: 'views.delete',
  kind: 'command',
  summary: 'Delete a saved view',
  input: ViewsDeleteInputSchema,
  output: ViewsDeleteOutputSchema,
  permission: 'workspace.write',
  risk: 'none',
  planning: 'none',
  audit: 'attempt+outcome',
  target: () => ({}),
  // Changes only the engine's own state, never a broker: the prod lock has nothing to arm (OQ-783).
  scope: 'local',
  http: { method: 'DELETE', path: '/views/{viewId}' },
  since: '1.0',
});
