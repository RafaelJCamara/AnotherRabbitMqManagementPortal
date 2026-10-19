// connections.delete: delete a connection profile and the credentials stored for it.
import { z } from 'zod';

import { ConnectionIdSchema } from '../brands.ts';
import { defineAction } from '../kit/define-action.ts';

export const ConnectionsDeleteInputSchema = z.strictObject({
  cid: ConnectionIdSchema,
});

export const ConnectionsDeleteOutputSchema = z.strictObject({
  deleted: z.boolean(),
});

export const connectionsDelete = defineAction({
  id: 'connections.delete',
  kind: 'command',
  summary: 'Delete a connection profile and its stored credentials',
  input: ConnectionsDeleteInputSchema,
  output: ConnectionsDeleteOutputSchema,
  permission: 'connection.manage',
  // The stored credentials cannot be recovered, so a plan is offered (and the policy may require one).
  risk: 'medium',
  planning: 'optional',
  audit: 'attempt+outcome',
  target: (input) => ({ connectionId: input.cid }),
  http: { method: 'DELETE', path: '/connections/{cid}' },
  since: '1.0',
});
