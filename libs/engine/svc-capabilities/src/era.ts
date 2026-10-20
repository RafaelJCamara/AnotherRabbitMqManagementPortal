// The era and the verification state of a profile (DC-01, DC-02, DC-60). The registry resolves them
// (I-3: every version comparison is its); this adds the two reasons only the engine knows, so the
// UI can show why an era is conservative.
import type { Build, BrokerProfile, Product, SemVer } from '@app/domain-model';
import type { BrokerSemanticsRegistry } from '@app/semantics';

export interface EraInput {
  readonly nodeVersions: readonly (SemVer | null)[];
  /** State of the `rabbitmq_4.3.0` feature flag; 'unknown' when it could not be read. */
  readonly ff43: 'enabled' | 'disabled' | 'unknown';
  /** State of the `rabbitmq_4.4.0` feature flag (amendment A-23); 'unknown' when it could not be read. */
  readonly ff44: 'enabled' | 'disabled' | 'unknown';
  readonly build: Build;
  /** Whether the product is RabbitMQ or a distribution of it. */
  readonly family: boolean;
  readonly product: Product;
  /** Broker versions with a green conformance run (OQ-100). */
  readonly lastVerified: readonly string[];
  readonly registry: BrokerSemanticsRegistry;
}

export function eraOf(
  input: EraInput,
): Pick<BrokerProfile, 'era' | 'verification'> {
  const resolved = input.registry.resolveEra({
    nodeVersions: input.nodeVersions,
    ff43Enabled:
      input.ff43 === 'unknown' ? 'unknown' : input.ff43 === 'enabled',
    ff44Enabled:
      input.ff44 === 'unknown' ? 'unknown' : input.ff44 === 'enabled',
    qqMachineVersions: [],
    build: input.build,
    lastVerified: input.lastVerified,
  });
  const reasons = [...resolved.reasons];
  if (!input.family) {
    reasons.push(
      `the product is ${input.product}: its version numbers are not RabbitMQ's, so no node has a RabbitMQ version`,
    );
  }
  if (resolved.era === '4.3' || resolved.era === '4.4') {
    reasons.push(
      'quorum-queue Machine Versions were not probed; the era rests on node versions and the feature flag',
    );
  }
  return {
    era: {
      value: resolved.era,
      reasons,
      conservative: resolved.conservative || !input.family,
    },
    verification: resolved.verification,
  };
}
