// connections.list: a window of the connection profiles the caller can see.
import { z } from 'zod';

import { defineAction } from '../kit/define-action.ts';
import {
  CONNECTIONS_PAGE_MAX,
  ConnectionProfileSchema,
} from './connections.ts';

export const ConnectionsListInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(CONNECTIONS_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(64).optional(),
});

export const ConnectionsListOutputSchema = z.strictObject({
  items: z.array(ConnectionProfileSchema).max(CONNECTIONS_PAGE_MAX),
  nextCursor: z.string().optional(),
});

export const connectionsList = defineAction({
  id: 'connections.list',
  kind: 'query',
  summary: 'List the connection profiles the caller can see, in windows',
  input: ConnectionsListInputSchema,
  output: ConnectionsListOutputSchema,
  permission: 'connection.view',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  http: { method: 'GET', path: '/connections' },
  since: '1.0',
});
