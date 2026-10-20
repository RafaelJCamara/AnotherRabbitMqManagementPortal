// The era and verification resolver (DC-01/02/60, blueprint 5.2, fact sheet b.8). It answers two
// separate questions about a cluster:
//
//  - which semantics era applies, resolved conservatively: when the evidence is incomplete or
//    contradictory the answer is 4.0-4.2, whose rules count every return and so never under-count;
//  - how far the exact build is covered by a green conformance run (`Verification`).
//
// Everything that is not provably the newer behaviour falls back; nothing here guesses upwards.
import {
  compareSemVer,
  formatCoreVersion,
  lowestSemVer,
  parseSemVer,
  type Build,
  type Era,
  type SemVer,
  type Verification,
} from '@app/domain-model';

export interface EraInputs {
  /** One entry per node; null for a node whose version could not be read or parsed. */
  readonly nodeVersions: readonly (SemVer | null)[];
  /** The `rabbitmq_4.3.0` feature flag; 'unknown' when it could not be read. */
  readonly ff43Enabled: boolean | 'unknown';
  /**
   * The `rabbitmq_4.4.0` feature flag (amendment A-23); 'unknown' when it could not be read. Only
   * consulted when every node is 4.4 or later; a 4.3 cluster ignores it.
   */
  readonly ff44Enabled: boolean | 'unknown';
  /**
   * The Machine Version each quorum-queue member reports (fact sheet 0.13). May be empty, which
   * means "not probed" and never demotes. 4.3 needs 8 or more, 4.4 needs 9 or more.
   */
  readonly qqMachineVersions: readonly number[];
  readonly build: Build;
  /** Broker versions with a green conformance run, as `major.minor.patch` (for example "4.3.6"). */
  readonly lastVerified: readonly string[];
}

export interface EraResolution {
  readonly era: Era;
  /** Why this era, in plain words; never empty. */
  readonly reasons: string[];
  /** True when the era is lower than the plain version numbers say, or the evidence is mixed. */
  readonly conservative: boolean;
  readonly verification: Verification;
}

/** The quorum-queue Machine Version that 4.3 behaviour needs (fact sheet 0.13). */
const MIN_QQ_MACHINE_VERSION_FOR_4_3 = 8;

/**
 * The 4.4 evidence, from amendment A-23: the feature flag and the quorum-queue Machine Version.
 * UNVERIFIED against the v4.4.x source: the repository shows the flag name and the number only in
 * A-23 and the new-broker-release runbook, and the fact sheet says "9 on main", not on the v4.4.x
 * branch (OQ-622). Both stay in these two constants so a reading of the source changes one place.
 */
const FF_4_4_NAME = 'rabbitmq_4.4.0';
const MIN_QQ_MACHINE_VERSION_FOR_4_4 = 9;

/**
 * The last patch that was published as an open-source release for each series whose community
 * support has ended (fact sheet section a, 2026-10-16). Later patches exist only in commercial
 * builds, may carry backports, and are therefore unknown builds. Move a series in here when its
 * community support ends; the new-broker-release runbook covers it.
 */
const LAST_PUBLIC_PATCH: Readonly<Record<string, number>> = {
  '3.13': 7,
  '4.0': 9,
  '4.1': 8,
  '4.2': 9,
};

/** The era the version numbers alone imply. Pre-release tags are ignored: 4.4.0-alpha is 4.4. */
function eraOfVersion(version: SemVer): Era {
  if (version.major < 4) return '3.13';
  if (version.major > 4 || version.minor >= 4) return '4.4';
  return version.minor >= 3 ? '4.3' : '4.0-4.2';
}

const ERA_RANK: Readonly<Record<Era, number>> = {
  '3.13': 0,
  '4.0-4.2': 1,
  '4.3': 2,
  '4.4': 3,
};

const VERIFICATION_RANK: Readonly<Record<Verification, number>> = {
  verified: 0,
  'unverified-patch': 1,
  'unverified-minor': 2,
  'unknown-build': 3,
};

const series = (version: SemVer): string =>
  `${String(version.major)}.${String(version.minor)}`;

function isPublicRelease(version: SemVer): boolean {
  const last = LAST_PUBLIC_PATCH[series(version)];
  return last === undefined || version.patch <= last;
}

function verificationOf(
  version: SemVer,
  lastVerified: readonly string[],
): Verification {
  if (!isPublicRelease(version)) return 'unknown-build';
  // A pre-release is never the version a conformance run covered.
  if (version.pre === undefined) {
    if (lastVerified.includes(formatCoreVersion(version))) return 'verified';
  }
  const sameSeries = lastVerified.some((entry) => {
    const verified = parseSemVer(entry);
    return verified !== null && series(verified) === series(version);
  });
  return sameSeries ? 'unverified-patch' : 'unverified-minor';
}

function resolveVerification(
  versions: readonly (SemVer | null)[],
  input: EraInputs,
): Verification {
  if (input.build !== 'oss' || versions.length === 0) return 'unknown-build';
  let worst: Verification = 'verified';
  for (const version of versions) {
    const verification =
      version === null
        ? 'unknown-build'
        : verificationOf(version, input.lastVerified);
    if (VERIFICATION_RANK[verification] > VERIFICATION_RANK[worst]) {
      worst = verification;
    }
  }
  return worst;
}

/**
 * Resolves the era and the verification state of a cluster. Rules, in order of precedence:
 *  1. any node below 4.0 gives 3.13;
 *  2. any node below 4.3 gives 4.0-4.2;
 *  3. otherwise the cluster is 4.3 (4.4 when every node is 4.4 or later), unless the evidence is
 *     incomplete: an unreadable node version, an unknown or commercial build, the `rabbitmq_4.3.0`
 *     flag not proven enabled, or a quorum-queue member below Machine Version 8 all give 4.0-4.2;
 *  4. a cluster that passed rule 3 as 4.4 stays 4.4 only with the `rabbitmq_4.4.0` flag positively
 *     enabled and no quorum-queue member below Machine Version 9; a disabled or unknown flag or a
 *     lower Machine Version gives 4.3 (OQ-623). The 4.4 flag never rescues missing 4.3 evidence.
 */
export function resolveEra(input: EraInputs): EraResolution {
  const reasons: string[] = [];
  const caution: string[] = [];
  const known = input.nodeVersions.filter(
    (version): version is SemVer => version !== null,
  );
  const unreadable = input.nodeVersions.length - known.length;

  if (input.nodeVersions.length === 0) {
    caution.push('no node versions were reported');
  } else if (unreadable > 0) {
    caution.push(
      `${String(unreadable)} node version(s) could not be read or parsed`,
    );
  }
  if (input.build !== 'oss') {
    caution.push('the build is commercial or unknown');
  }
  for (const version of known) {
    if (!isPublicRelease(version)) {
      caution.push(
        `${version.raw} has no public release tag, so it may carry backports`,
      );
    }
  }

  const lowest = lowestSemVer(known);
  let era: Era = '4.0-4.2';
  if (lowest === null) {
    reasons.push('no readable node version, so the conservative era applies');
  } else {
    era = eraOfVersion(lowest);
    reasons.push(
      `the lowest node version is ${lowest.raw}, which implies ${era}`,
    );
  }

  const highest = known.reduce<SemVer | null>(
    (best, version) =>
      best === null || compareSemVer(version, best) > 0 ? version : best,
    null,
  );
  if (highest !== null && ERA_RANK[eraOfVersion(highest)] > ERA_RANK[era]) {
    caution.push(
      `mixed versions: ${highest.raw} implies ${eraOfVersion(highest)} but the cluster keeps the rules of ${era}`,
    );
  }

  if (ERA_RANK[era] >= ERA_RANK['4.3']) {
    // The evidence for 4.3 behaviour must be positive; absence of evidence is not evidence.
    const demote: string[] = [];
    if (input.ff43Enabled === false) {
      demote.push('the rabbitmq_4.3.0 feature flag is not enabled');
    } else if (input.ff43Enabled === 'unknown') {
      demote.push('the rabbitmq_4.3.0 feature flag state is unknown');
    }
    for (const machineVersion of input.qqMachineVersions) {
      if (machineVersion < MIN_QQ_MACHINE_VERSION_FOR_4_3) {
        demote.push(
          `a quorum-queue member reports Machine Version ${String(machineVersion)}, below ${String(MIN_QQ_MACHINE_VERSION_FOR_4_3)}`,
        );
        break;
      }
    }
    // Already explained above: an unreadable version, an unknown build or a non-public release.
    const incomplete =
      unreadable > 0 ||
      input.build !== 'oss' ||
      known.some((version) => !isPublicRelease(version));
    if (demote.length > 0 || incomplete) {
      era = '4.0-4.2';
      caution.push(...demote);
    }
  }

  if (era === '4.4') {
    // Every node is 4.4 or later and the 4.3 evidence holds; 4.4 needs its own positive evidence.
    const missing: string[] = [];
    if (input.ff44Enabled === false) {
      missing.push(`the ${FF_4_4_NAME} feature flag is not enabled`);
    } else if (input.ff44Enabled === 'unknown') {
      missing.push(`the ${FF_4_4_NAME} feature flag state is unknown`);
    }
    const low = input.qqMachineVersions.find(
      (machineVersion) => machineVersion < MIN_QQ_MACHINE_VERSION_FOR_4_4,
    );
    if (low !== undefined) {
      missing.push(
        `a quorum-queue member reports Machine Version ${String(low)}, below ${String(MIN_QQ_MACHINE_VERSION_FOR_4_4)}`,
      );
    }
    if (missing.length > 0) {
      era = '4.3';
      caution.push(
        ...missing,
        'every node is 4.4 or later, but the 4.4 evidence is incomplete, so the cluster keeps the rules of 4.3',
      );
    }
  }

  if (caution.length === 0) {
    reasons.push(
      era === '4.4'
        ? `the ${FF_4_4_NAME} flag is enabled and no quorum-queue member reports a lower Machine Version than 4.4 needs`
        : ERA_RANK[era] >= ERA_RANK['4.3']
          ? 'the rabbitmq_4.3.0 flag is enabled and no quorum-queue member is below the required Machine Version'
          : 'no sign of newer behaviour in the cluster',
    );
  }

  return {
    era,
    reasons: [...reasons, ...caution],
    conservative: caution.length > 0,
    verification: resolveVerification(input.nodeVersions, input),
  };
}
