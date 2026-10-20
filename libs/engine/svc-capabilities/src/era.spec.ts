// AC-5 and AC-6 of M0-46: the era and the verification state of a built profile. The resolving is the
// registry's (tested in libs/shared/semantics); these prove the profile carries it, with the reasons.
import { describe, expect, it } from 'vitest';

import { fixtureRoutes } from './fixtures';
import { brokerRoutes, probeBroker } from './gates/gates.fixture';
import type { Route } from './testing';

const flagState = (state: 'enabled' | 'disabled'): Route =>
  (fixtureRoutes('4.3.6')['/api/feature-flags'] as { name: string }[]).map(
    (flag) => (flag.name === 'rabbitmq_4.3.0' ? { ...flag, state } : flag),
  );

/**
 * SYNTHETIC 4.4 probe (no 4.4 recording exists): the 4.3.6 recording with the version changed and a
 * `rabbitmq_4.4.0` flag added, or left out. It proves the profile carries the rule, not 4.4 behaviour.
 */
const synthetic44 = (flag?: 'enabled' | 'disabled'): Record<string, Route> => ({
  '/api/overview': {
    ...(fixtureRoutes('4.3.6')['/api/overview'] as object),
    rabbitmq_version: '4.4.0',
  },
  '/api/feature-flags': [
    ...(flagState('enabled') as object[]),
    ...(flag === undefined ? [] : [{ name: 'rabbitmq_4.4.0', state: flag }]),
  ],
});

const version437: Record<string, Route> = {
  '/api/overview': {
    ...(fixtureRoutes('4.3.6')['/api/overview'] as object),
    rabbitmq_version: '4.3.7',
  },
};

describe('gates era and verification', () => {
  it('AC-5 gates: 4.3.6 with rabbitmq_4.3.0 disabled has era 4.0-4.2 with the reason shown', async () => {
    const off = await probeBroker(
      brokerRoutes('4.3.6', { '/api/feature-flags': flagState('disabled') }),
    );
    const on = await probeBroker(
      brokerRoutes('4.3.6', { '/api/feature-flags': flagState('enabled') }),
    );

    expect(off.profile.era.value).toBe('4.0-4.2');
    expect(off.profile.era.conservative).toBe(true);
    expect(
      off.profile.era.reasons.filter((line) => line.includes('rabbitmq_4.3.0')),
    ).toHaveLength(1);
    expect(on.profile.era.value).toBe('4.3');
    expect(on.profile.era.conservative).toBe(false);
  });

  it('AC-6 gates: 4.3.7 with 4.3.6 verified has verification unverified-patch', async () => {
    const routes = brokerRoutes('4.3.6', version437);
    const patch = await probeBroker(routes, { lastVerified: ['4.3.6'] });
    const minor = await probeBroker(routes, { lastVerified: [] });
    const exact = await probeBroker(routes, { lastVerified: ['4.3.7'] });

    expect(patch.profile.verification).toBe('unverified-patch');
    expect(patch.profile.era.value).toBe('4.3');
    expect(minor.profile.verification).toBe('unverified-minor');
    expect(exact.profile.verification).toBe('verified');
  });

  it('AC-9 the profile reads rabbitmq_4.4.0 and shows why 4.4 was not reached', async () => {
    const on = await probeBroker(brokerRoutes('4.3.6', synthetic44('enabled')));
    const off = await probeBroker(
      brokerRoutes('4.3.6', synthetic44('disabled')),
    );
    const absent = await probeBroker(brokerRoutes('4.3.6', synthetic44()));
    const reasonsOf = (profile: { era: { reasons: string[] } }) =>
      profile.era.reasons.filter((line) => line.includes('rabbitmq_4.4.0'));

    expect(on.profile.era.value).toBe('4.4');
    expect(on.profile.era.conservative).toBe(false);
    expect(
      on.profile.era.reasons.some((line) => line.includes('not probed')),
    ).toBe(true);
    expect(off.profile.era.value).toBe('4.3');
    expect(off.profile.era.conservative).toBe(true);
    expect(reasonsOf(off.profile)).toEqual([
      'the rabbitmq_4.4.0 feature flag is not enabled',
    ]);
    expect(absent.profile.era.value).toBe('4.3');
    expect(absent.profile.era.conservative).toBe(true);
    expect(reasonsOf(absent.profile)).toEqual([
      'the rabbitmq_4.4.0 feature flag state is unknown',
    ]);
  });
});
