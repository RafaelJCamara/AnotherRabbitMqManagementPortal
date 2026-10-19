// The acceptance criteria of M0-47, through the real ActionExecutor over the module's fakes, plus
// the limits and the owner scoping that keep the workspace bounded and personal.
import {
  ConnectionIdSchema,
  KEYBINDINGS_MAX,
  LAYOUTS_PER_OWNER_MAX,
  VIEWS_PER_OWNER_MAX,
  WORKSPACE_SETTING_DEFAULTS,
  keybindingsGet,
  keybindingsPut,
  layoutsGet,
  layoutsPut,
  settingsGet,
  settingsPut,
  viewsCreate,
  viewsDelete,
  viewsList,
  type ActionDef,
  type InputOf,
  type OutputOf,
} from '@app/contracts';
import {
  createTestContext,
  createTestExecutor,
  createTestPrincipal,
  type ExecutorContext,
} from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { createWorkspaceModule } from './module';
import { createWorkspaceFakeDeps } from './testing';

/** A connection id, branded as the contract wants it. */
const cid = (id: string) => ConnectionIdSchema.parse(id);

function createEngine() {
  const deps = createWorkspaceFakeDeps();
  const engine = createTestExecutor();
  for (const action of createWorkspaceModule(deps).actions) {
    engine.executor.register(action as never);
  }
  let calls = 0;
  /** Runs one action as `owner` (default: the first test user) and returns its output. */
  const call = async <A extends ActionDef>(
    def: A,
    input: InputOf<A>,
    owner = 'user-1',
  ): Promise<OutputOf<A>> => {
    calls += 1;
    const ctx: ExecutorContext = createTestContext({
      principal: createTestPrincipal({ id: owner }),
      idempotencyKey: `workspace-spec-${String(calls)}`,
    });
    const outcome = await engine.executor.run(def, input, ctx);
    if (outcome.kind !== 'output') {
      throw new Error(`expected an output, got ${outcome.kind}`);
    }
    return outcome.output;
  };
  return { deps, engine, call };
}

describe('svc-workspace', () => {
  it('AC-1 a view saved on connection A is listed on connection B, and layouts are stored per profile', async () => {
    const { call } = createEngine();

    // The person works on connection "a": a layout for it, and a view of the queues grid.
    await call(layoutsPut, { cid: cid('a'), layout: { panels: ['explorer'] } });
    const { view } = await call(viewsCreate, {
      name: 'Busy queues',
      kind: 'queues',
      definition: { filter: { regex: '^orders' }, columns: ['name', 'ready'] },
    });
    // Then on connection "b": its own layout, and the same views.
    await call(layoutsPut, {
      cid: cid('b'),
      layout: { panels: ['tap', 'dlq'] },
    });

    const listed = await call(viewsList, {});
    expect(listed.items).toEqual([view]);
    expect(listed.items[0]?.definition).toEqual({
      filter: { regex: '^orders' },
      columns: ['name', 'ready'],
    });
    expect((await call(layoutsGet, { cid: cid('a') })).layout).toEqual({
      panels: ['explorer'],
    });
    expect((await call(layoutsGet, { cid: cid('b') })).layout).toEqual({
      panels: ['tap', 'dlq'],
    });
    expect(await call(layoutsGet, { cid: cid('c') })).toEqual({
      layout: null,
      updatedAt: null,
    });
  });

  it('AC-2 a settings write with an unknown key is refused with VALIDATION_FAILED and stores nothing', async () => {
    const { call, engine } = createEngine();

    await expect(
      call(settingsPut, {
        settings: { timeDisplay: 'utc', colourScheme: 'dark' },
      } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect((await call(settingsGet, {})).settings).toEqual(
      WORKSPACE_SETTING_DEFAULTS,
    );
    expect(engine.audit.attempts).toEqual([]);
  });

  it('a settings write with a known key but a bad value is VALIDATION_FAILED too', async () => {
    const { call } = createEngine();

    await expect(
      call(settingsPut, { settings: { defaultPageSize: 5000 } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a settings write changes only the keys it names, over the defaults', async () => {
    const { call } = createEngine();

    await call(settingsPut, { settings: { timeDisplay: 'utc' } });
    const after = await call(settingsPut, {
      settings: { defaultPageSize: 25 },
    });

    expect(after.settings).toEqual({
      locale: 'en',
      timeDisplay: 'utc',
      defaultPageSize: 25,
    });
    expect((await call(settingsGet, {})).settings).toEqual(after.settings);
  });

  it('a stored setting that no longer fits, or is no longer known, is ignored and never returned', async () => {
    const { call, deps } = createEngine();
    await deps.workspace.putDocument(
      'user-1',
      'setting',
      'timeDisplay',
      'sideways',
    );
    await deps.workspace.putDocument('user-1', 'setting', 'retired', true);
    await deps.workspace.putDocument(
      'user-1',
      'setting',
      'defaultPageSize',
      20,
    );

    expect((await call(settingsGet, {})).settings).toEqual({
      ...WORKSPACE_SETTING_DEFAULTS,
      defaultPageSize: 20,
    });
  });

  it('keeps one person workspace apart from another: views, layouts, settings and keybindings', async () => {
    const { call } = createEngine();
    const { view } = await call(viewsCreate, {
      name: 'Mine',
      kind: 'queues',
      definition: {},
    });
    await call(layoutsPut, { cid: cid('a'), layout: { mine: true } });
    await call(settingsPut, { settings: { locale: 'pt-BR' } });
    await call(keybindingsPut, { bindings: { 'go-to.explorer': 'Alt+1' } });

    expect((await call(viewsList, {}, 'user-2')).items).toEqual([]);
    expect(
      (await call(layoutsGet, { cid: cid('a') }, 'user-2')).layout,
    ).toBeNull();
    expect((await call(settingsGet, {}, 'user-2')).settings).toEqual(
      WORKSPACE_SETTING_DEFAULTS,
    );
    expect(await call(keybindingsGet, {}, 'user-2')).toEqual({ bindings: {} });
    // Another person cannot delete the view either: to them it does not exist.
    await expect(
      call(viewsDelete, { viewId: view.id }, 'user-2'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await call(viewsList, {})).items).toEqual([view]);
  });

  it('lists views in windows of the requested size, by kind, with a cursor', async () => {
    const { call } = createEngine();
    for (const [name, kind] of [
      ['one', 'queues'],
      ['two', 'exchanges'],
      ['three', 'queues'],
    ] as const) {
      await call(viewsCreate, { name, kind, definition: {} });
    }

    const first = await call(viewsList, { limit: 2 });
    expect(first.nextCursor).toBeDefined();
    const second = await call(viewsList, {
      limit: 2,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    });
    const queues = await call(viewsList, { kind: 'queues' });

    expect(first.items.map((view) => view.name)).toEqual(['one', 'two']);
    expect(second.items.map((view) => view.name)).toEqual(['three']);
    expect(second.nextCursor).toBeUndefined();
    expect(queues.items.map((view) => view.name)).toEqual(['one', 'three']);
  });

  it('deletes a view once, then says it is not found', async () => {
    const { call } = createEngine();
    const { view } = await call(viewsCreate, {
      name: 'Gone',
      kind: 'queues',
      definition: {},
    });

    await call(viewsDelete, { viewId: view.id });

    expect((await call(viewsList, {})).items).toEqual([]);
    await expect(call(viewsDelete, { viewId: view.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a view past the cap per person, and an oversized document', async () => {
    const { call } = createEngine();
    for (let index = 0; index < VIEWS_PER_OWNER_MAX; index += 1) {
      await call(viewsCreate, {
        name: `v${String(index)}`,
        kind: 'q',
        definition: {},
      });
    }

    await expect(
      call(viewsCreate, { name: 'one too many', kind: 'q', definition: {} }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await expect(
      call(
        viewsCreate,
        { name: 'big', kind: 'q', definition: { text: 'x'.repeat(20_000) } },
        'user-2',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // Another person is not affected by the cap.
    await expect(
      call(viewsCreate, { name: 'fine', kind: 'q', definition: {} }, 'user-2'),
    ).resolves.toMatchObject({ view: { name: 'fine' } });
  }, 60_000);

  it('refuses a layout for a new profile past the cap, but always replaces an existing one', async () => {
    const { call } = createEngine();
    for (let index = 0; index < LAYOUTS_PER_OWNER_MAX; index += 1) {
      await call(layoutsPut, {
        cid: cid(`c${String(index)}`),
        layout: { n: index },
      });
    }

    await expect(
      call(layoutsPut, { cid: cid('c-new'), layout: {} }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await call(layoutsPut, { cid: cid('c0'), layout: { n: 'replaced' } });
    expect((await call(layoutsGet, { cid: cid('c0') })).layout).toEqual({
      n: 'replaced',
    });
  }, 60_000);

  it('stores keybinding overrides as a whole, replaces them on write, and bounds their number', async () => {
    const { call } = createEngine();
    await call(keybindingsPut, {
      bindings: { 'go-to.explorer': 'Alt+1', 'queues.purge': null },
    });
    await call(keybindingsPut, { bindings: { 'go-to.tap': 'Alt+2' } });

    expect(await call(keybindingsGet, {})).toEqual({
      bindings: { 'go-to.tap': 'Alt+2' },
    });
    const tooMany = Object.fromEntries(
      Array.from({ length: KEYBINDINGS_MAX + 1 }, (_, index) => [
        `cmd.n${String(index)}`,
        'Alt+X',
      ]),
    );
    await expect(
      call(keybindingsPut, { bindings: tooMany }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('leaves an audit attempt and outcome for a command and none for a query', async () => {
    const { call, engine } = createEngine();

    await call(settingsPut, { settings: { locale: 'de' } });
    await call(settingsGet, {});

    expect(engine.audit.attempts.map((row) => row.actionId)).toEqual([
      settingsPut.id,
    ]);
    expect(engine.audit.outcomes).toMatchObject([
      { actionId: settingsPut.id, result: 'ok' },
    ]);
  });
});
