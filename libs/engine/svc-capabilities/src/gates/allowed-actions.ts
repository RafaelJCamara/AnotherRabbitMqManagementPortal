// allowedActions: what this principal may call on this broker, so the UI renders it and never
// computes authorisation. An action is allowed when the authorizer says yes for its permission AND
// every feature it needs is open. Deny by default: no authorizer, a refusal or any answer that is
// not exactly `allowed: true` leaves the action out. Never cached and never fingerprinted.
import type {
  ActionId,
  EngineMode,
  EnvClass,
  FeatureId,
  Permission,
} from '@app/contracts';
import type { BrokerProfile } from '@app/domain-model';
import type { Authorizer } from '@app/kernel';
import type { Principal } from '@app/ports';

/** The features an action needs; an action that is not listed needs none (Q-6). */
export type ActionFeatures = Readonly<Record<string, readonly FeatureId[]>>;

/** No registered action needs a gate today. */
export const DEFAULT_ACTION_FEATURES: ActionFeatures = {};

export interface AllowedActionsInput {
  readonly profile: BrokerProfile;
  readonly principal: Principal;
  readonly mode: EngineMode;
  readonly env: EnvClass;
  readonly authorizer: Authorizer;
  readonly actions: readonly { id: ActionId; permission: Permission }[];
  readonly featuresOf: ActionFeatures;
}

/** Actions the principal holds the permission for and whose every feature is open. Sorted by id. */
export async function computeAllowedActions(
  input: AllowedActionsInput,
): Promise<ActionId[]> {
  const { profile } = input;
  const candidates = input.actions.filter((action) =>
    (input.featuresOf[action.id] ?? []).every(
      (feature) => profile.gates[feature]?.enabled === true,
    ),
  );
  const answers = await Promise.all(
    candidates.map(async (action): Promise<unknown> => {
      try {
        return await input.authorizer.authorize({
          principal: input.principal,
          permission: action.permission,
          actionId: action.id,
          target: { connectionId: profile.connectionId },
          mode: input.mode,
          env: input.env,
        });
      } catch {
        return undefined; // an authorizer that fails does not say yes
      }
    }),
  );
  return candidates
    .filter(
      (_, index) =>
        (answers[index] as { allowed?: unknown } | undefined)?.allowed === true,
    )
    .map((action) => action.id)
    .sort();
}
