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
    qqMachineVersions: [8],
    build: 'oss',
    lastVerified: VERIFIED,
    ...overrides,
  };
}

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

  it('resolves a cluster that is entirely 4.4 to 4.4, still unverified', () => {
    const result = resolveEra(
      cluster(['4.4.0-alpha.1a2b3c', '4.4.0-alpha.1a2b3c']),
    );

    expect(result.era).toBe('4.4');
    expect(result.verification).toBe('unverified-minor');
  });

  it('does not reach 4.4 while one node is still 4.3', () => {
    const result = resolveEra(cluster(['4.4.0', '4.3.6']));

    expect(result.era).toBe('4.3');
    expect(result.conservative).toBe(true);
  });

  it('needs the same positive evidence for 4.4 as for 4.3', () => {
    const result = resolveEra(
      cluster(['4.4.0', '4.4.0'], { ff43Enabled: false }),
    );

    expect(result.era).toBe('4.0-4.2');
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
