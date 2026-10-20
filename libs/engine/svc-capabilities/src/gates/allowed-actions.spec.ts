// AC-10 and AC-11 of M0-46: `allowedActions` of profile.get. It is per principal, deny by default,
// and never part of the cache or the fingerprint.
import {
  bundlesExport,
  diagnosticsBundle,
  probeRun,
  profileGet,
  type FeatureId,
  FeatureIdSchema,
} from '@app/contracts';
import {
  createTestContext,
  createTestExecutor,
  type Authorizer,
} from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { createProbeRunAction } from '../actions/probe-run';
import { createProfileGetAction } from '../actions/profile-get';
import { createCapabilitiesFakeDeps, type Route } from '../testing';
import { amazonRoutes, brokerRoutes } from './gates.fixture';

const STREAMS: FeatureId = FeatureIdSchema.parse('streams.browse');
const FEATURES_OF = { [bundlesExport.id]: [STREAMS] };

const holding = (...permissions: string[]): Authorizer => ({
  authorize: (request) =>
    Promise.resolve(
      permissions.includes(request.permission)
        ? { allowed: true }
        : { allowed: false, reason: 'no' },
    ),
});

/** Probes the scripted broker through probe.run, then reads the profile through profile.get. */
async function read(routes: Record<string, Route>, authorizer?: Authorizer) {
  const deps = {
    ...createCapabilitiesFakeDeps({ routes }),
    ...(authorizer === undefined ? {} : { authorizer }),
    featuresOf: FEATURES_OF,
  };
  const engine = createTestExecutor();
  engine.executor.register(
    createProbeRunAction(deps),
    createProfileGetAction(deps),
  );
  const ctx = (key: string) => createTestContext({ idempotencyKey: key });
  await engine.executor.run(probeRun, { cid: 'c1' }, ctx('probe'));
  const done = await engine.executor.run(profileGet, { cid: 'c1' }, ctx('get'));
  if (done.kind !== 'output') throw new Error('expected an output');
  const output = done.output as {
    profile: { allowedActions?: string[]; fingerprint: string };
  };
  return { deps, output };
}

describe('gates allowedActions', () => {
  it('AC-10 gates: allowedActions are the permitted actions whose features are open, computed per principal and never cached', async () => {
    const authorizer = holding(
      'connection.view',
      'connection.manage',
      bundlesExport.permission,
    );

    const closed = await read(amazonRoutes(), authorizer);
    const open = await read(brokerRoutes('4.2.9'), authorizer);

    const allowed = closed.output.profile.allowedActions ?? [];
    expect(allowed).toContain(profileGet.id);
    expect(allowed).toContain(probeRun.id);
    // The permission is held but streams.browse is closed on Amazon MQ.
    expect(allowed).not.toContain(bundlesExport.id);
    // The feature is open here, but this principal does not hold the permission.
    expect(allowed).not.toContain(diagnosticsBundle.id);
    expect(open.output.profile.allowedActions).toContain(bundlesExport.id);
    expect(open.output.profile.allowedActions).not.toContain(
      diagnosticsBundle.id,
    );
    expect(allowed).toEqual([...allowed].sort());

    const stored = closed.deps.profiles.rows.get('c1');
    expect(stored?.profile).not.toHaveProperty('allowedActions');
    expect(stored?.fingerprint).toBe(closed.output.profile.fingerprint);
  });

  it('AC-11 gates: allowedActions is empty when the authorizer is missing or does not say yes', async () => {
    const refusing: Authorizer = {
      authorize: () => Promise.resolve({ allowed: false, reason: 'no' }),
    };
    const vague = {
      authorize: () => Promise.resolve({ allowed: 'yes' }),
    } as unknown as Authorizer;
    const failing: Authorizer = {
      authorize: () => Promise.reject(new Error('down')),
    };

    for (const authorizer of [undefined, refusing, vague, failing]) {
      const { output } = await read(brokerRoutes('4.2.9'), authorizer);

      expect(output.profile.allowedActions).toEqual([]);
    }
  });
});
