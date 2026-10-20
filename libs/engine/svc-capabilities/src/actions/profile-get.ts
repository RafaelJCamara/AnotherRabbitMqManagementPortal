// profile.get: Read the cached BrokerProfile of a connection
import { profileGet, registry as contractRegistry } from '@app/contracts';
import { BrokerProfileSchema } from '@app/domain-model';
import {
  AppError,
  denyAllAuthorizer,
  implementAction,
  type ActionImpl,
} from '@app/kernel';

import type { CapabilitiesModuleDeps } from '../deps';
import {
  computeAllowedActions,
  DEFAULT_ACTION_FEATURES,
} from '../gates/allowed-actions';
import { requireVisible } from '../internal/visible';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type ProfileGetDeps = Pick<
  CapabilitiesModuleDeps,
  'profiles' | 'connections' | 'authorizer' | 'featuresOf'
>;

export const createProfileGetAction = (
  deps: ProfileGetDeps,
): ActionImpl<typeof profileGet> =>
  implementAction(profileGet, {
    execute: async (input, ctx) => {
      await requireVisible(deps.connections, input.cid, ctx.principal.id);
      const record = await deps.profiles.get(input.cid);
      if (record === undefined) {
        throw new AppError('NOT_FOUND', {
          detail:
            'This connection has not been probed yet. Run the probe first.',
        });
      }
      const profile = BrokerProfileSchema.safeParse(record.profile);
      if (!profile.success) {
        // A profile written by another version of the engine: the cache is a copy, so ask again.
        throw new AppError('NOT_FOUND', {
          detail:
            'The cached profile of this connection is out of date. Run the probe again.',
        });
      }
      // Per principal, so it is added here and never cached or fingerprinted.
      const allowedActions = await computeAllowedActions({
        profile: profile.data,
        principal: ctx.principal,
        mode: ctx.mode,
        env: ctx.env,
        authorizer: deps.authorizer ?? denyAllAuthorizer,
        actions: contractRegistry.actions,
        featuresOf: deps.featuresOf ?? DEFAULT_ACTION_FEATURES,
      });
      return { profile: { ...profile.data, allowedActions } };
    },
  });
