// connections.get: one connection profile. Secrets are reported only as set or not set.
import { z } from 'zod';

import { ConnectionIdSchema } from '../brands.ts';
import { defineAction } from '../kit/define-action.ts';
import { ConnectionProfileSchema } from './connections.ts';

export const ConnectionsGetInputSchema = z.strictObject({
  cid: ConnectionIdSchema,
});

export const ConnectionsGetOutputSchema = z.strictObject({
  profile: ConnectionProfileSchema,
});

export const connectionsGet = defineAction({
  id: 'connections.get',
  kind: 'query',
  summary:
    'Read one connection profile; secrets are reported only as set or not set',
  input: ConnectionsGetInputSchema,
  output: ConnectionsGetOutputSchema,
  permission: 'connection.view',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: (input) => ({ connectionId: input.cid }),
  http: { method: 'GET', path: '/connections/{cid}' },
  since: '1.0',
});
