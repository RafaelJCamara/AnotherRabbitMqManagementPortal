// Mounts one page of the explorer for a component spec: the real Transloco scope (English), the real
// grid in a DOM that has no layout (so it renders every row it holds), a connection id, the model's
// fake data port for the inventory and the real `EngineApi` over a fake engine for everything else
// (the profile and the saved views). Never part of the library build.
import {
  inject,
  signal,
  type EnvironmentProviders,
  type Provider,
  type Type,
  type WritableSignal,
} from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  createFakeExplorerData,
  type FakeExplorerData,
} from '@app/explorer-model/testing';
import { explorerWindowTopic, type TopicDef } from '@app/contracts';
import {
  EngineApi,
  ENGINE_PARSE,
  LiveClient,
  provideEngineData,
} from '@app/ui-data';
import { ENGINE_TRANSPORT } from '@app/ui-platform';
import {
  FakeEngine,
  MemoryTransport,
  type FakeHandler,
} from '@app/ui-platform/testing';
import { provideGridRenderAll } from '@app/ui-grid/testing';
import { provideTransloco } from '@jsverse/transloco';

import { EXPLORER_CONNECTION } from '../connection';
import { createEngineExplorerData } from '../data/engine-explorer-data';
import { EXPLORER_DATA } from '../data/explorer-data';
import { provideExplorerScope } from '../explorer-scope';
import { METRICS_FRAME } from '../metrics/frame';
import { answerInventory } from './explorer-testbed';
import { FakeWorkspace } from './fake-workspace';

/** Answers a REST request of a spec before the testbed does (undefined: not mine). */
export type PageRoutes = (
  request: Parameters<FakeHandler>[0],
) =>
  | Awaited<ReturnType<FakeHandler>>
  | undefined
  | Promise<Awaited<ReturnType<FakeHandler>> | undefined>;

export interface PageBed<T> {
  readonly fixture: ComponentFixture<T>;
  readonly el: HTMLElement;
  readonly fake: FakeExplorerData;
  readonly workspace: FakeWorkspace;
  /** The fake engine behind `EngineApi`: every request it received is in `engine.requests`. */
  readonly engine: FakeEngine;
  readonly connection: WritableSignal<string | null>;
}

/** Providers every explorer page spec needs. */
export function pageProviders(
  fake: FakeExplorerData,
  connection: WritableSignal<string | null>,
  engine: FakeEngine,
): (EnvironmentProviders | Provider)[] {
  return [
    provideTransloco({
      config: { availableLangs: ['en'], defaultLang: 'en', prodMode: true },
    }),
    provideExplorerScope(),
    provideGridRenderAll(),
    provideEngineData(),
    { provide: ENGINE_TRANSPORT, useValue: new MemoryTransport(engine) },
    { provide: ENGINE_PARSE, useValue: true },
    { provide: EXPLORER_CONNECTION, useValue: connection },
    { provide: EXPLORER_DATA, useValue: fake },
    // The metrics views redraw at once in a spec; one that checks the coalescing provides its own scheduler.
    {
      provide: METRICS_FRAME,
      useValue: {
        request: (callback: () => void) => {
          callback();
          return () => undefined;
        },
      },
    },
  ];
}

export async function mountPage<T>(
  type: Type<T>,
  options: {
    readonly fake?: FakeExplorerData;
    readonly workspace?: FakeWorkspace;
    readonly cid?: string | null;
    readonly inputs?: Readonly<Record<string, unknown>>;
    readonly providers?: readonly Provider[];
    /**
     * The page reads the inventory and follows the topic through the real engine-backed data port over the
     * fake engine (the inventory answered by `fake`), so every request the page makes is on `engine`.
     */
    readonly engineBacked?: boolean;
    /** Answers a REST request before the rest of the testbed does (undefined: not mine). */
    readonly routes?: PageRoutes;
    /** More live topics the fake engine serves (the explorer's is added with `engineBacked`). */
    readonly topics?: readonly TopicDef[];
  } = {},
): Promise<PageBed<T>> {
  const fake = options.fake ?? createFakeExplorerData({ autoSnapshot: true });
  const workspace = options.workspace ?? new FakeWorkspace();
  const engineBacked = options.engineBacked === true;
  const base: FakeHandler = engineBacked
    ? async (request) =>
        (await answerInventory(fake, request)) ??
        (await workspace.handler(request))
    : workspace.handler;
  const topics = [
    ...(engineBacked ? [explorerWindowTopic] : []),
    ...(options.topics ?? []),
  ];
  const engine = new FakeEngine({
    handler: async (request) =>
      (await options.routes?.(request)) ?? (await base(request)),
    ...(topics.length > 0 ? { topics } : {}),
  });
  const connection = signal<string | null>(
    options.cid === undefined ? 'c1' : options.cid,
  );
  TestBed.resetTestingModule(); // a spec may mount several pages: each starts from a clean module
  TestBed.configureTestingModule({
    providers: [
      ...pageProviders(fake, connection, engine),
      ...(engineBacked
        ? [
            {
              provide: EXPLORER_DATA,
              useFactory: () =>
                createEngineExplorerData(inject(EngineApi), inject(LiveClient)),
            },
          ]
        : []),
      ...(options.providers ?? []),
    ],
  });
  const fixture = TestBed.createComponent(type);
  for (const [name, value] of Object.entries(options.inputs ?? {})) {
    fixture.componentRef.setInput(name, value);
  }
  const el = fixture.nativeElement as HTMLElement;
  document.body.append(el);
  await fixture.whenStable();
  return { fixture, el, fake, workspace, engine, connection };
}
