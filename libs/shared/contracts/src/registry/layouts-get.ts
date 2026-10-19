// layouts.get: the saved workspace layout of a connection profile, or null when there is none.
import { z } from 'zod';

import { ConnectionIdSchema } from '../brands.ts';
import { defineAction } from '../kit/define-action.ts';
import { LayoutDocumentSchema } from './workspace.ts';

export const LayoutsGetInputSchema = z.strictObject({
  cid: ConnectionIdSchema,
});

export const LayoutsGetOutputSchema = z.strictObject({
  layout: LayoutDocumentSchema.nullable(),
  updatedAt: z.number().int().nonnegative().nullable(),
});

export const layoutsGet = defineAction({
  id: 'layouts.get',
  kind: 'query',
  summary: 'Read the saved workspace layout of a connection profile',
  input: LayoutsGetInputSchema,
  output: LayoutsGetOutputSchema,
  permission: 'workspace.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: (input) => ({ connectionId: input.cid }),
  http: { method: 'GET', path: '/connections/{cid}/layout' },
  since: '1.0',
});
