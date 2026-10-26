// Feeds the TokenManager's `capabilities` callback from the semantics registry (M1-23, OQ-1452).
// The three questions are registry rules (`auth-capabilities.data.ts`); this project asks them and
// compares no version itself (I-3). The rule holds only while every node of the cluster is proven
// inside its range, so a mixed or unreadable cluster answers "no" (the conservative side).
//
// A rule the registry does not have is a `SemanticsGapError`: it is not caught here. The manager
// counts it (`capabilityErrors`) and takes the conservative branch (it cancels its own consumers
// at expiry, reconnects AMQP 1.0 and measures a login against the smaller frame).
import type { CapabilityProfile } from '@app/semantics';

import type { IdentityCapabilities } from './token-manager';

/** The part of the semantics registry this project uses. */
export interface CapabilitySource {
  capability(id: string, profile: CapabilityProfile): boolean;
}

export interface RegistryCapabilitiesDeps {
  readonly registry: CapabilitySource;
  /**
   * The broker profile of a connection, or undefined when none is known (a connection that was
   * never probed). The composition root implements it over the capability probe (slice E).
   */
  profileFor(connectionId: string): CapabilityProfile | undefined;
}

export function createRegistryCapabilities(
  deps: RegistryCapabilitiesDeps,
): (connectionId: string) => IdentityCapabilities {
  return (connectionId) => {
    const profile = deps.profileFor(connectionId);
    // No profile means no evidence about the broker: nothing is proven.
    if (profile === undefined) {
      return {
        amqp10TokenRenewalEndpoint: false,
        amqp091ClosesAtCredentialExpiry: false,
        amqp091PreAuthFrame8192: false,
      };
    }
    return {
      amqp10TokenRenewalEndpoint: deps.registry.capability(
        'amqp10TokenRenewalEndpoint',
        profile,
      ),
      amqp091ClosesAtCredentialExpiry: deps.registry.capability(
        'amqp091ClosesAtCredentialExpiry',
        profile,
      ),
      amqp091PreAuthFrame8192: deps.registry.capability(
        'amqp091PreAuthFrame8192',
        profile,
      ),
    };
  };
}
