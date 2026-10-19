// profile.get: Read the cached BrokerProfile of a connection
import { z } from 'zod';

import { ConnectionIdSchema } from '../brands.ts';
import { defineAction } from '../kit/define-action.ts';

export const ProfileGetInputSchema = z.strictObject({
  cid: ConnectionIdSchema,
});

/**
 * The BrokerProfile (`BrokerProfileSchema` of `@app/domain-model`) is `unknown` here: domain-model
 * imports this library for its branded ids, so the schema cannot be named from this side. The
 * service parses what it returns with `BrokerProfileSchema`, and a UI reads it with the same.
 */
export const ProfileGetOutputSchema = z.strictObject({
  profile: z.unknown(),
});

export const profileGet = defineAction({
  id: 'profile.get',
  kind: 'query',
  summary: 'Read the cached BrokerProfile of a connection',
  input: ProfileGetInputSchema,
  output: ProfileGetOutputSchema,
  permission: 'connection.view',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: (input) => ({ connectionId: input.cid }),
  http: { method: 'GET', path: '/connections/{cid}/profile' },
  since: '1.0',
});
