// connections.update: change a connection profile. A secret is replaced only when a new one is sent.
import { z } from 'zod';

import { ConnectionIdSchema } from '../brands.ts';
import { EnvClassSchema } from '../config/env.ts';
import { defineAction } from '../kit/define-action.ts';
import {
  AmqpInputSchema,
  ColorSchema,
  ConnectionNameSchema,
  ConnectionProfileSchema,
  ConnectionVisibilitySchema,
  HttpInputSchema,
} from './connections.ts';

export const ConnectionsUpdateInputSchema = z.strictObject({
  cid: ConnectionIdSchema,
  name: ConnectionNameSchema.optional(),
  envClass: EnvClassSchema.optional(),
  /** `null` removes the colour. */
  color: ColorSchema.nullable().optional(),
  visibility: ConnectionVisibilitySchema.optional(),
  /** Fields left out keep their value. */
  http: HttpInputSchema.optional(),
  amqp: AmqpInputSchema.optional(),
});

export const ConnectionsUpdateOutputSchema = z.strictObject({
  profile: ConnectionProfileSchema,
});

export const connectionsUpdate = defineAction({
  id: 'connections.update',
  kind: 'command',
  summary:
    'Change a connection profile; a secret is replaced only when a new one is sent',
  input: ConnectionsUpdateInputSchema,
  output: ConnectionsUpdateOutputSchema,
  permission: 'connection.manage',
  risk: 'low',
  planning: 'none',
  audit: 'attempt+outcome',
  target: (input) => ({ connectionId: input.cid }),
  http: { method: 'PATCH', path: '/connections/{cid}' },
  since: '1.0',
});
