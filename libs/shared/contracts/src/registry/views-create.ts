// views.create: save a view (filters, columns, sort) that is available on every connection.
import { z } from 'zod';

import { defineAction } from '../kit/define-action.ts';
import {
  SavedViewSchema,
  ViewDefinitionSchema,
  ViewKindSchema,
} from './workspace.ts';

export const ViewsCreateInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  kind: ViewKindSchema,
  definition: ViewDefinitionSchema,
});

export const ViewsCreateOutputSchema = z.strictObject({
  view: SavedViewSchema,
});

export const viewsCreate = defineAction({
  id: 'views.create',
  kind: 'command',
  summary: 'Save a view (filters, columns, sort) that works on any connection',
  input: ViewsCreateInputSchema,
  output: ViewsCreateOutputSchema,
  permission: 'workspace.write',
  risk: 'none',
  planning: 'none',
  audit: 'attempt+outcome',
  target: () => ({}),
  http: { method: 'POST', path: '/views' },
  since: '1.0',
});
