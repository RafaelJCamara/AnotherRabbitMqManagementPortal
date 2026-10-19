// views.list: a window of the caller's saved views. A view is not bound to a connection, so the
// same list answers on every connection.
import { z } from 'zod';

import { defineAction } from '../kit/define-action.ts';
import {
  SavedViewSchema,
  VIEWS_PAGE_MAX,
  ViewKindSchema,
} from './workspace.ts';

export const ViewsListInputSchema = z.strictObject({
  kind: ViewKindSchema.optional(),
  limit: z.number().int().min(1).max(VIEWS_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(64).optional(),
});

export const ViewsListOutputSchema = z.strictObject({
  items: z.array(SavedViewSchema).max(VIEWS_PAGE_MAX),
  nextCursor: z.string().optional(),
});

export const viewsList = defineAction({
  id: 'views.list',
  kind: 'query',
  summary: 'List the saved views of the caller',
  input: ViewsListInputSchema,
  output: ViewsListOutputSchema,
  permission: 'workspace.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  http: { method: 'GET', path: '/views' },
  since: '1.0',
});
