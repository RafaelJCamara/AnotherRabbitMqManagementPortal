// connections.create: save a connection profile with separate HTTP and AMQP endpoints and credentials.
import { z } from 'zod';

import { defineAction } from '../kit/define-action.ts';
import {
  ColorSchema,
  ConnectionNameSchema,
  ConnectionProfileSchema,
  ConnectionVisibilitySchema,
  EndpointsInputSchema,
} from './connections.ts';
import { EnvClassSchema } from '../config/env.ts';

export const ConnectionsCreateInputSchema = z.strictObject({
  name: ConnectionNameSchema,
  envClass: EnvClassSchema,
  color: ColorSchema.optional(),
  /** `private` (the default) is the creator's own; `team` is listed for everyone on a team server. */
  visibility: ConnectionVisibilitySchema.optional(),
  ...EndpointsInputSchema.shape,
});

export const ConnectionsCreateOutputSchema = z.strictObject({
  profile: ConnectionProfileSchema,
});

export const connectionsCreate = defineAction({
  id: 'connections.create',
  kind: 'command',
  summary:
    'Save a connection profile with separate HTTP and AMQP endpoints and credentials',
  input: ConnectionsCreateInputSchema,
  output: ConnectionsCreateOutputSchema,
  permission: 'connection.manage',
  risk: 'low',
  planning: 'none',
  audit: 'attempt+outcome',
  // A new profile has no connection to name yet, so the production lock cannot be armed for it (OQ-380).
  // The declared local scope below is what lets it through (OQ-783).
  target: () => ({}),
  // Changes only the engine's own state, never a broker: the prod lock has nothing to arm (OQ-783).
  scope: 'local',
  http: { method: 'POST', path: '/connections' },
  since: '1.0',
});
