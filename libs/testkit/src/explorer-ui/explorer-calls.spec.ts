// M0-54 AC-28, the end-to-end half: the calls the explorer UI makes, sent through the real router over the real
// executor (`createTestEngine`) to the real actions of the three services behind them, with the services' in-memory
// fakes for the broker, the profile store and the workspace store. The UI's own half (what the pages send, against a
// fake engine) is `explorer-requests.spec.ts` in the feature. Every answer is parsed with the contract schema the UI
// parses it with. No browser and no real broker are involved.
import {
  inventoryQuery,
  overviewGet,
  profileGet,
  viewsCreate,
  viewsDelete,
  viewsList,
} from '@app/contracts';
import { BrokerProfileSchema } from '@app/domain-model';
import {
  createCapabilitiesFakeDeps,
  createProfileGetAction,
} from '@app/svc-capabilities';
import {
  createExplorerFakeDeps,
  createInventoryQueryAction,
  createOverviewGetAction,
} from '@app/svc-explorer';
import {
  createViewsCreateAction,
  createViewsDeleteAction,
  createViewsListAction,
  createWorkspaceFakeDeps,
} from '@app/svc-workspace';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestEngine, type TestEngine } from '../create-test-engine.ts';

let engine: TestEngine;

afterEach(async () => {
  await engine.close();
});

/** The test engine's caller is the launch-token user, who must own the fake connection and the views. */
function explorerEngine(): TestEngine {
  const explorer = createExplorerFakeDeps({ ownerId: 'local-token' });
  const workspace = createWorkspaceFakeDeps();
  return createTestEngine({
    actions: [
      createInventoryQueryAction(explorer),
      createOverviewGetAction(explorer),
      createProfileGetAction(
        createCapabilitiesFakeDeps({ ownerId: 'local-token', seeded: true }),
      ),
      createViewsListAction(workspace),
      createViewsCreateAction(workspace),
      createViewsDeleteAction(workspace),
    ],
  });
}

describe('the calls of the explorer UI through the real router', () => {
  it('M0-54 AC-28 the read calls and the view commands of the explorer answer in the shape the UI parses', async () => {
    engine = explorerEngine();

    // inventory.query: the first block of each kind, the way the window source asks for it.
    for (const kind of ['queues', 'exchanges', 'connections'] as const) {
      const answer = await engine.inject({
        method: 'POST',
        path: '/connections/c1/inventory/queries',
        payload: { kind, window: { offset: 0, limit: 200 } },
      });
      expect(answer.statusCode, kind).toBe(200);
      const parsed = inventoryQuery.output.safeParse(answer.json());
      expect(parsed.success, kind).toBe(true);
      expect(parsed.data?.kind).toBe(kind);
      expect(parsed.data?.rows.length).toBeLessThanOrEqual(200);
    }
    const bindings = await engine.inject({
      method: 'POST',
      path: '/connections/c1/inventory/queries',
      payload: {
        kind: 'bindings',
        filter: { vhosts: ['/'] },
        window: { offset: 0, limit: 200 },
      },
    });
    expect(bindings.statusCode).toBe(200);
    expect(inventoryQuery.output.safeParse(bindings.json()).success).toBe(true);

    // overview.get and profile.get: the overview page and the views and capability card read these.
    const overview = await engine.inject({
      method: 'GET',
      path: '/connections/c1/overview',
    });
    expect(overview.statusCode).toBe(200);
    expect(overviewGet.output.safeParse(overview.json()).success).toBe(true);
    const profile = await engine.inject({
      method: 'GET',
      path: '/connections/c1/profile',
    });
    expect(profile.statusCode).toBe(200);
    expect(profileGet.output.safeParse(profile.json()).success).toBe(true);
    // The UI parses the profile itself with the strict schema, so it must be one.
    const body = profile.json<{ profile: unknown }>();
    expect(BrokerProfileSchema.safeParse(body.profile).success).toBe(true);
    // The list the UI opens Save and Delete from is on the profile. These fake deps have no authorizer, so deny by
    // default leaves it empty here; that the real engine lists the view commands is not proved by this spec.
    expect(
      (body.profile as { allowedActions?: unknown }).allowedActions,
    ).toEqual([]);

    // views.list: the person's views, not bound to a connection, filtered by kind.
    const list = await engine.inject({
      method: 'GET',
      path: '/views?kind=queues',
    });
    expect(list.statusCode).toBe(200);
    expect(viewsList.output.safeParse(list.json()).success).toBe(true);

    // views.create and views.delete are commands on no connection and declare scope 'local' (they change only
    // the engine's own state), so the prod lock has nothing to arm and the engine runs them (OQ-783).
    const create = await engine.inject({
      method: 'POST',
      path: '/views',
      payload: {
        name: 'Busy queues',
        kind: 'queues',
        definition: { version: 1, kind: 'queues', filter: { text: 'orders' } },
      },
      headers: { 'idempotency-key': 'explorer-calls-spec-0001' },
    });
    expect(create.statusCode).toBe(200);
    const created = viewsCreate.output.parse(create.json());
    const remove = await engine.inject({
      method: 'DELETE',
      path: `/views/${created.view.id}`,
      headers: { 'idempotency-key': 'explorer-calls-spec-0002' },
    });
    expect(remove.statusCode).toBe(200);
    expect(viewsDelete.output.safeParse(remove.json()).success).toBe(true);

    // Nothing the explorer calls changed the broker.
    expect(engine.writeCalls).toEqual([]);
  });
});
