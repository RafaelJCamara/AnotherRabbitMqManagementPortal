import { parseSemVer, type SemVer } from '@app/domain-model';
import { describe, expect, it } from 'vitest';
import { resolveEra, type EraInputs } from './era.ts';

const v = (text: string): SemVer => {
  const parsed = parseSemVer(text);
  if (parsed === null) throw new Error(`test setup: ${text} does not parse`);
  return parsed;
};

const VERIFIED = ['3.13.7', '4.0.9', '4.1.8', '4.2.9', '4.3.6'] as const;

/** A healthy, fully verified cluster; each test changes what it is about. */
function cluster(
  versions: readonly (string | null)[],
  overrides: Partial<EraInputs> = {},
): EraInputs {
  return {
    nodeVersions: versions.map((text) => (text === null ? null : v(text))),
    ff43Enabled: true,
    ff44Enabled: true,
    qqMachineVersions: [8],
    build: 'oss',
    lastVerified: VERIFIED,
    ...overrides,
  };
}

/** All the evidence 4.3 and 4.4 need; nodes are given by the test. */
const FULL_EVIDENCE: Partial<EraInputs> = {
  ff44Enabled: true,
  qqMachineVersions: [9],
};

const mentions = (reasons: readonly string[], text: string): boolean =>
  reasons.some((reason) => reason.includes(text));

describe('resolveEra: AC-1 the conservative era', () => {
  it('AC-1 nodes [4.3.6,4.3.6] with rabbitmq_4.3.0 disabled resolve to 4.0-4.2, conservative, with a reason', () => {
    const result = resolveEra(
      cluster(['4.3.6', '4.3.6'], { ff43Enabled: false }),
    );

    expect(result.era).toBe('4.0-4.2');
    expect(result.conservative).toBe(true);
    expect(mentions(result.reasons, 'rabbitmq_4.3.0')).toBe(true);
  });

  it('AC-1 nodes [4.3.6,4.2.9] resolve to 4.0-4.2, conservative, with a reason', () => {
    const result = resolveEra(cluster(['4.3.6', '4.2.9']));

    expect(result.era).toBe('4.0-4.2');
    expect(result.conservative).toBe(true);
    expect(mentions(result.reasons, 'mixed versions')).toBe(true);
  });

  it('AC-1 any quorum-queue member with Machine Version below 8 resolves to 4.0-4.2, conservative, with a reason', () => {
    const result = resolveEra(
      cluster(['4.3.6', '4.3.6', '4.3.6'], { qqMachineVersions: [8, 8, 7] }),
    );

    expect(result.era).toBe('4.0-4.2');
    expect(result.conservative).toBe(true);
    expect(mentions(result.reasons, 'Machine Version 7')).toBe(true);
  });

  it('AC-1 4.2.10 (no public tag) resolves to 4.0-4.2 and unknown-build', () => {
    const result = resolveEra(cluster(['4.2.10']));

    expect(result.era).toBe('4.0-4.2');
    expect(result.verification).toBe('unknown-build');
    expect(result.conservative).toBe(true);
    expect(mentions(result.reasons, '4.2.10')).toBe(true);
  });

  it('AC-1 4.2.10 is an unknown build even when the probe says the build is open source', () => {
    const open = resolveEra(cluster(['4.2.10'], { build: 'oss' }));
    const commercial = resolveEra(
      cluster(['4.2.10'], { build: 'commercial-or-unknown' }),
    );

    expect(open.verification).toBe('unknown-build');
    expect(commercial.verification).toBe('unknown-build');
    expect(commercial.era).toBe('4.0-4.2');
  });

  it('AC-1 4.3.7 resolves to 4.3 and unverified-patch', () => {
    const result = resolveEra(cluster(['4.3.7']));

    expect(result.era).toBe('4.3');
    expect(result.verification).toBe('unverified-patch');
    expect(result.conservative).toBe(false);
  });
});

describe('resolveEra: the plain cases', () => {
  it('resolves a verified 4.3.6 cluster to 4.3 without caution', () => {
    const result = resolveEra(cluster(['4.3.6', '4.3.6', '4.3.6']));

    expect(result).toMatchObject({
      era: '4.3',
      conservative: false,
      verification: 'verified',
    });
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it.each([
    ['3.13.7', '3.13'],
    ['4.0.9', '4.0-4.2'],
    ['4.1.8', '4.0-4.2'],
    ['4.2.9', '4.0-4.2'],
  ] as const)(
    'resolves a verified %s cluster to %s without caution',
    (version, era) => {
      const result = resolveEra(cluster([version]));

      expect(result).toMatchObject({
        era,
        conservative: false,
        verification: 'verified',
      });
    },
  );

  it('does not need the 4.3 flag or a machine version below 4.3', () => {
    const result = resolveEra(
      cluster(['4.2.9'], { ff43Enabled: false, qqMachineVersions: [7] }),
    );

    expect(result.era).toBe('4.0-4.2');
    expect(result.conservative).toBe(false);
  });

  it('keeps 4.3 when no quorum-queue member was observed and when members are at 8 or later', () => {
    expect(resolveEra(cluster(['4.3.6'], { qqMachineVersions: [] })).era).toBe(
      '4.3',
    );
    expect(
      resolveEra(cluster(['4.3.6'], { qqMachineVersions: [8, 9] })).era,
    ).toBe('4.3');
  });
});

describe('resolveEra: evidence that is missing is not evidence', () => {
  it('treats an unknown feature flag state as not enabled', () => {
    const result = resolveEra(cluster(['4.3.6'], { ff43Enabled: 'unknown' }));

    expect(result.era).toBe('4.0-4.2');
    expect(result.conservative).toBe(true);
  });

  it('falls back when a node version could not be read', () => {
    const result = resolveEra(cluster(['4.3.6', null]));

    expect(result.era).toBe('4.0-4.2');
    expect(result.conservative).toBe(true);
    expect(result.verification).toBe('unknown-build');
  });

  it('falls back when there are no node versions at all', () => {
    const result = resolveEra(cluster([]));

    expect(result).toMatchObject({
      era: '4.0-4.2',
      conservative: true,
      verification: 'unknown-build',
    });
  });

  it('treats a commercial or unknown build as 4.0-4.2 with an unknown build', () => {
    const result = resolveEra(
      cluster(['4.3.6'], { build: 'commercial-or-unknown' }),
    );

    expect(result).toMatchObject({
      era: '4.0-4.2',
      conservative: true,
      verification: 'unknown-build',
    });
  });

  it('keeps the older era of a commercial build below 4.3 but marks it conservative', () => {
    const result = resolveEra(
      cluster(['3.13.7'], { build: 'commercial-or-unknown' }),
    );

    expect(result.era).toBe('3.13');
    expect(result.conservative).toBe(true);
    expect(result.verification).toBe('unknown-build');
  });
});

describe('resolveEra: mixed and newer clusters', () => {
  it('uses the oldest node: a 3.13 node keeps the whole cluster at 3.13, conservatively', () => {
    const result = resolveEra(cluster(['3.13.7', '4.3.6']));

    expect(result.era).toBe('3.13');
    expect(result.conservative).toBe(true);
  });
});

/** A cluster of two 4.4.0 nodes with every piece of 4.4 evidence present. */
function cluster44(overrides: Partial<EraInputs> = {}): EraInputs {
  return cluster(['4.4.0', '4.4.0'], {
    ff44Enabled: true,
    qqMachineVersions: [9, 9],
    ...overrides,
  });
}

describe('resolveEra: the 4.4 evidence (M0-75, amendment A-23)', () => {
  it('AC-1 all nodes 4.4, flag enabled and Machine Version 9 resolve to 4.4', () => {
    const result = resolveEra(cluster44());

    expect(result.era).toBe('4.4');
    expect(result.conservative).toBe(false);
    expect(mentions(result.reasons, 'keeps the rules')).toBe(false);
    expect(mentions(result.reasons, 'not enabled')).toBe(false);
  });

  it('AC-2 a disabled rabbitmq_4.4.0 flag demotes 4.4 to 4.3 with the reason', () => {
    const result = resolveEra(cluster44({ ff44Enabled: false }));

    expect(result.era).toBe('4.3');
    expect(result.conservative).toBe(true);
    expect(
      mentions(result.reasons, 'rabbitmq_4.4.0 feature flag is not enabled'),
    ).toBe(true);
  });

  it('AC-3 an unknown rabbitmq_4.4.0 flag state demotes 4.4 to 4.3', () => {
    const result = resolveEra(cluster44({ ff44Enabled: 'unknown' }));

    expect(result.era).toBe('4.3');
    expect(result.conservative).toBe(true);
    expect(
      mentions(result.reasons, 'rabbitmq_4.4.0 feature flag state is unknown'),
    ).toBe(true);
  });

  it('AC-4 a quorum-queue member below Machine Version 9 demotes 4.4 to 4.3', () => {
    const result = resolveEra(cluster44({ qqMachineVersions: [9, 8] }));

    expect(result.era).toBe('4.3');
    expect(result.conservative).toBe(true);
    expect(mentions(result.reasons, 'Machine Version 8, below 9')).toBe(true);
  });

  it('AC-5 only a cluster whose every node qualifies resolves to 4.4', () => {
    const mixed = resolveEra(cluster(['4.4.0', '4.3.6'], FULL_EVIDENCE));
    const unreadable = resolveEra(cluster(['4.4.0', null], FULL_EVIDENCE));

    expect(mixed.era).toBe('4.3');
    expect(mentions(mixed.reasons, 'mixed versions')).toBe(true);
    expect(unreadable.era).not.toBe('4.4');
    expect(mentions(unreadable.reasons, 'could not be read')).toBe(true);
  });

  it('AC-6 the 4.3 evidence rules still apply first for a 4.4 cluster', () => {
    const noFlag = resolveEra(cluster44({ ff43Enabled: false }));
    const lowMachineVersion = resolveEra(
      cluster44({ qqMachineVersions: [9, 7] }),
    );

    expect(noFlag.era).toBe('4.0-4.2');
    expect(lowMachineVersion.era).toBe('4.0-4.2');
    expect(mentions(noFlag.reasons, 'rabbitmq_4.3.0')).toBe(true);
  });

  it('AC-7 a 4.3.6 cluster ignores the 4.4 flag', () => {
    const unknown = resolveEra(
      cluster(['4.3.6'], { ff44Enabled: 'unknown', qqMachineVersions: [] }),
    );
    const disabled = resolveEra(
      cluster(['4.3.6'], { ff44Enabled: false, qqMachineVersions: [] }),
    );

    expect(unknown).toMatchObject({
      era: '4.3',
      conservative: false,
      verification: 'verified',
    });
    expect(disabled).toEqual(unknown);
    expect(mentions(unknown.reasons, 'rabbitmq_4.4.0')).toBe(false);
  });

  it('AC-8 a 4.4 pre-release resolves to 4.4 but is never verified', () => {
    const alpha = ['4.4.0-alpha.1a2b3c'];
    const result = resolveEra(cluster(alpha, FULL_EVIDENCE));
    const alsoListed = resolveEra(
      cluster(alpha, { ...FULL_EVIDENCE, lastVerified: ['4.4.0'] }),
    );

    expect(result.era).toBe('4.4');
    expect(result.verification).toBe('unverified-minor');
    // OQ-643: with 4.4.0 itself verified, a 4.4 pre-release is the same series, so unverified-patch.
    expect(alsoListed.era).toBe('4.4');
    expect(alsoListed.verification).toBe('unverified-patch');
  });

  it('does not demote 4.4 for Machine Versions that were not probed (an empty list)', () => {
    const result = resolveEra(cluster44({ qqMachineVersions: [] }));

    expect(result.era).toBe('4.4');
    expect(result.conservative).toBe(false);
  });
});
describe('resolveEra: verification', () => {
  it('is verified only for the exact version of every node', () => {
    expect(resolveEra(cluster(['4.3.6', '4.3.6'])).verification).toBe(
      'verified',
    );
    expect(resolveEra(cluster(['4.3.6', '4.3.7'])).verification).toBe(
      'unverified-patch',
    );
  });

  it('is unverified-minor for a minor with no verified version', () => {
    const result = resolveEra(cluster(['4.3.6'], { lastVerified: ['4.2.9'] }));

    expect(result.verification).toBe('unverified-minor');
    expect(result.era).toBe('4.3');
  });

  it('is unverified-minor when nothing is verified yet', () => {
    expect(
      resolveEra(cluster(['4.3.6'], { lastVerified: [] })).verification,
    ).toBe('unverified-minor');
  });

  it('never calls a pre-release verified', () => {
    const result = resolveEra(cluster(['4.3.6-rc.1']));

    expect(result.verification).toBe('unverified-patch');
  });

  it('takes the weakest verification across nodes', () => {
    const result = resolveEra(cluster(['4.3.6', '4.3.7', '4.3.6']));

    expect(result.verification).toBe('unverified-patch');
  });

  it.each(['3.13.8', '4.0.10', '4.1.9', '4.2.10', '4.2.11'])(
    'treats %s, a patch after the last public release of a retired series, as an unknown build',
    (version) => {
      expect(resolveEra(cluster([version])).verification).toBe('unknown-build');
    },
  );

  it('still treats a patch of the current series after the verified one as unverified-patch', () => {
    expect(resolveEra(cluster(['4.3.8'])).verification).toBe(
      'unverified-patch',
    );
  });
});
