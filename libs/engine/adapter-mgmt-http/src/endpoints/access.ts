// Policies, operator policies, users and permissions. Some providers switch operator-policy
// changes off: the single-policy resource then answers 405 'Broker settings disallow ...' for every
// method, GET included (managed-brokers research, V16), which `errors.ts` turns into a gate.
import { z } from 'zod';

import { defineEndpoint, defineList } from './define.ts';

const Definition = z.record(z.string(), z.unknown());

export const PolicySchema = z.object({
  name: z.string(),
  vhost: z.string(),
  pattern: z.string(),
  'apply-to': z.string(),
  priority: z.number().int(),
  definition: Definition,
});
export type MgmtPolicy = z.infer<typeof PolicySchema>;

export const policies = {
  list: defineList({
    id: 'policies.list',
    template: '/api/policies',
    item: PolicySchema,
  }),
  inVhost: defineList({
    id: 'policies.inVhost',
    template: '/api/policies/{vhost}',
    item: PolicySchema,
  }),
  one: defineEndpoint({
    id: 'policies.one',
    template: '/api/policies/{vhost}/{name}',
    schema: PolicySchema,
  }),
};

export const operatorPolicies = {
  list: defineList({
    id: 'operatorPolicies.list',
    template: '/api/operator-policies',
    item: PolicySchema,
  }),
  inVhost: defineList({
    id: 'operatorPolicies.inVhost',
    template: '/api/operator-policies/{vhost}',
    item: PolicySchema,
  }),
  one: defineEndpoint({
    id: 'operatorPolicies.one',
    template: '/api/operator-policies/{vhost}/{name}',
    schema: PolicySchema,
  }),
};

/** The password hash is never read: the schema leaves it out, so it never leaves the adapter. */
export const UserSchema = z.object({
  name: z.string(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
});
export type MgmtUser = z.infer<typeof UserSchema>;

export const users = {
  list: defineList({
    id: 'users.list',
    template: '/api/users',
    item: UserSchema,
  }),
  one: defineEndpoint({
    id: 'users.one',
    template: '/api/users/{name}',
    schema: UserSchema,
  }),
};

export const PermissionSchema = z.object({
  user: z.string(),
  vhost: z.string(),
  configure: z.string(),
  write: z.string(),
  read: z.string(),
});
export type MgmtPermission = z.infer<typeof PermissionSchema>;

export const permissions = {
  list: defineList({
    id: 'permissions.list',
    template: '/api/permissions',
    item: PermissionSchema,
  }),
  one: defineEndpoint({
    id: 'permissions.one',
    template: '/api/permissions/{vhost}/{user}',
    schema: PermissionSchema,
  }),
};
