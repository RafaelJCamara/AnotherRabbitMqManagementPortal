// The first run, the engine's half (the UI's half is `libs/ui/feature-explorer/src/lib/profile/first-run.component.spec.ts`):
// a connection nobody has probed answers 404 NOT_FOUND to `profile.get` and to `inventory.query`, which is the signal
// the explorer pages key on; `overview.get` does not need a profile; one `probe.run` stores the profile; and from then
// on both answer 200. The calls go through the real router over the real executor with the services' in-memory fakes
// (the probe and the explorer share one profile store here, as the engine's database does). No browser, no real
// broker: that the probe parses a real broker's answers is proved by `svc-capabilities:it`.
import {
  inventoryQuery,
  overviewGet,
  probeRun,
  profileGet,
} from '@app/contracts';
import { BrokerProfileSchema } from '@app/domain-model';
import {
  createCapabilitiesFakeDeps,
  createProbeRunAction,
  createProfileGetAction,
} from '@app/svc-capabilities';
import {
  createExplorerFakeDeps,
  createInventoryQueryAction,
  createOverviewGetAction,
} from '@app/svc-explorer';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestEngine, type TestEngine } from '../create-test-engine.ts';

let engine: TestEngine;

afterEach(async () => {
  await engine.close();
});

const QUEUES = {
  method: 'POST',
  path: '/connections/c1/inventory/queries',
  payload: { kind: 'queues', window: { offset: 0, limit: 200 } },
} as const;

describe('the first run of the explorer through the real router', () => {
  it('FIRST-RUN-1 an unprobed connection answers 404 NOT_FOUND to the profile and the inventory, the overview still answers, one probe makes both answer 200', async () => {
    const capabilities = createCapabilitiesFakeDeps({
      ownerId: 'local-token',
      seeded: false,
    });
    const explorer = {
      ...createExplorerFakeDeps({ ownerId: 'local-token', seeded: false }),
      // The probe writes this store and the explorer reads it: one engine database.
      profiles: capabilities.profiles,
    };
    engine = createTestEngine({
      actions: [
        createProbeRunAction(capabilities),
        createProfileGetAction(capabilities),
        createInventoryQueryAction(explorer),
        createOverviewGetAction(explorer),
      ],
    });

    // Before the probe: the two reads the page makes first both say NOT_FOUND, in words the page can show.
    const profile = await engine.inject({
      method: 'GET',
      path: '/connections/c1/profile',
    });
    expect(profile.statusCode).toBe(404);
    const problem = profile.json<{ code: string; detail: string }>();
    expect(problem.code).toBe('NOT_FOUND');
    expect(problem.detail).toContain('has not been probed yet');
    const refused = await engine.inject(QUEUES);
    expect(refused.statusCode).toBe(404);
    const refusal = refused.json<{ code: string; detail: string }>();
    expect(refusal.code).toBe('NOT_FOUND');
    expect(refusal.detail).toContain('has not been probed yet');
    // The overview reads the broker itself and needs no profile.
    const overview = await engine.inject({
      method: 'GET',
      path: '/connections/c1/overview',
    });
    expect(overview.statusCode).toBe(200);
    expect(overviewGet.output.safeParse(overview.json()).success).toBe(true);

    // The probe the page's button runs: no body, a query action (no idempotency key needed), and its answer is the
    // profile the page uses at once, in a shape the page's strict schema reads.
    const probe = await engine.inject({
      method: 'POST',
      path: '/connections/c1/probe',
    });
    expect(probe.statusCode).toBe(200);
    const probed = probeRun.output.parse(probe.json());
    expect(BrokerProfileSchema.safeParse(probed.profile).success).toBe(true);
    expect(probed.steps.length).toBeGreaterThan(0);

    // After it: the profile is there and the first block of the inventory is answered.
    const after = await engine.inject({
      method: 'GET',
      path: '/connections/c1/profile',
    });
    expect(after.statusCode).toBe(200);
    expect(profileGet.output.safeParse(after.json()).success).toBe(true);
    const list = await engine.inject(QUEUES);
    expect(list.statusCode).toBe(200);
    expect(inventoryQuery.output.parse(list.json()).kind).toBe('queues');

    // Nothing in the whole sequence changed the broker.
    expect(engine.writeCalls).toEqual([]);
  });
});
