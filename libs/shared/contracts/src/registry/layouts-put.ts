// layouts.put: save the workspace layout of a connection profile, for the caller.
import { z } from 'zod';

import { ConnectionIdSchema } from '../brands.ts';
import { defineAction } from '../kit/define-action.ts';
import { LayoutDocumentSchema } from './workspace.ts';

export const LayoutsPutInputSchema = z.strictObject({
  cid: ConnectionIdSchema,
  layout: LayoutDocumentSchema,
});

export const LayoutsPutOutputSchema = z.strictObject({});

export const layoutsPut = defineAction({
  id: 'layouts.put',
  kind: 'command',
  summary: 'Save the workspace layout of a connection profile',
  input: LayoutsPutInputSchema,
  output: LayoutsPutOutputSchema,
  permission: 'workspace.write',
  risk: 'none',
  planning: 'none',
  audit: 'attempt+outcome',
  target: (input) => ({ connectionId: input.cid }),
  http: { method: 'PUT', path: '/connections/{cid}/layout' },
  since: '1.0',
});
