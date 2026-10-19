// The workspace routes together, through the real router (M0-47): what a client sees of layouts
// per profile, views that belong to no connection, and a settings write with an unknown key.
import {
  createKeybindingsGetAction,
  createKeybindingsPutAction,
  createLayoutsGetAction,
  createLayoutsPutAction,
  createSettingsGetAction,
  createSettingsPutAction,
  createViewsCreateAction,
  createViewsDeleteAction,
  createViewsListAction,
  createWorkspaceFakeDeps,
} from '@app/svc-workspace';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestEngine, type TestEngine } from '../create-test-engine.ts';

let engine: TestEngine;

/** Every workspace action over one set of fakes, as the module registers them. */
function createModuleActions() {
  const deps = createWorkspaceFakeDeps();
  return {
    workspace: deps.workspace,
    actions: [
      createLayoutsGetAction(deps),
      createLayoutsPutAction(deps),
      createViewsListAction(deps),
      createViewsCreateAction(deps),
      createViewsDeleteAction(deps),
      createSettingsGetAction(deps),
      createSettingsPutAction(deps),
      createKeybindingsGetAction(deps),
      createKeybindingsPutAction(deps),
    ],
  };
}

afterEach(async () => {
  await engine.close();
});

describe('workspace over HTTP', () => {
  it('HTTP-1 layouts are per connection profile: each cid has its own, and an unsaved one is null', async () => {
    const deps = createModuleActions();
    engine = createTestEngine({ actions: deps.actions });
    engine.arm('c1');
    engine.arm('c2');

    for (const [cid, panels] of [
      ['c1', ['explorer']],
      ['c2', ['tap']],
    ] as const) {
      const saved = await engine.inject({
        method: 'PUT',
        path: `/connections/${cid}/layout`,
        payload: { layout: { panels } },
        headers: { 'idempotency-key': `layout-${cid}` },
      });
      expect(saved.statusCode).toBe(200);
    }

    const read = async (cid: string): Promise<unknown> =>
      (await engine.inject({ path: `/connections/${cid}/layout` })).json();
    expect(await read('c1')).toMatchObject({
      layout: { panels: ['explorer'] },
    });
    expect(await read('c2')).toMatchObject({ layout: { panels: ['tap'] } });
    expect(await read('c3')).toEqual({ layout: null, updatedAt: null });
  });

  it('HTTP-2 saved views are listed on every connection: the route has no connection in it', async () => {
    const deps = createModuleActions();
    engine = createTestEngine({ actions: deps.actions });
    await deps.workspace.insertView({
      id: 'v1',
      ownerId: engine.principal.id,
      name: 'Busy queues',
      kind: 'queues',
      definition: { filter: 'orders' },
      createdAt: 1,
      updatedAt: 1,
    });

    const listed = await engine.inject({ path: '/views?kind=queues&limit=10' });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        {
          id: 'v1',
          name: 'Busy queues',
          kind: 'queues',
          definition: { filter: 'orders' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    expect((await engine.inject({ path: '/views?limit=0' })).statusCode).toBe(
      400,
    );
    expect((await engine.inject({ path: '/views?limit=201' })).statusCode).toBe(
      400,
    );
  });

  it('HTTP-3 a settings write with an unknown key is a 400 VALIDATION_FAILED Problem and nothing is audited', async () => {
    const deps = createModuleActions();
    engine = createTestEngine({ actions: deps.actions });

    const answer = await engine.inject({
      method: 'PUT',
      path: '/settings',
      payload: { settings: { timeDisplay: 'utc', colourScheme: 'dark' } },
      headers: { 'idempotency-key': 'settings-1' },
    });

    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(engine.audit.attempts).toEqual([]);
    expect((await engine.inject({ path: '/settings' })).json()).toEqual({
      settings: { locale: 'en', timeDisplay: 'local', defaultPageSize: 50 },
    });
  });
});
