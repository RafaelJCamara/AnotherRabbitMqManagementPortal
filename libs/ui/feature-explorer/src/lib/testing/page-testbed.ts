// Mounts one page of the explorer for a component spec: the real Transloco scope (English), the real
// grid in a DOM that has no layout (so it renders every row it holds), a connection id, the model's
// fake data port for the inventory and the real `EngineApi` over a fake engine for everything else
// (the profile and the saved views). Never part of the library build.
import {
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
import { ENGINE_PARSE, provideEngineData } from '@app/ui-data';
import { ENGINE_TRANSPORT } from '@app/ui-platform';
import { FakeEngine, MemoryTransport } from '@app/ui-platform/testing';
import { provideGridRenderAll } from '@app/ui-grid/testing';
import { provideTransloco } from '@jsverse/transloco';

import { EXPLORER_CONNECTION } from '../connection';
import { EXPLORER_DATA } from '../data/explorer-data';
import { provideExplorerScope } from '../explorer-scope';
import { FakeWorkspace } from './fake-workspace';

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
  } = {},
): Promise<PageBed<T>> {
  const fake = options.fake ?? createFakeExplorerData({ autoSnapshot: true });
  const workspace = options.workspace ?? new FakeWorkspace();
  const engine = new FakeEngine({ handler: workspace.handler });
  const connection = signal<string | null>(
    options.cid === undefined ? 'c1' : options.cid,
  );
  TestBed.resetTestingModule(); // a spec may mount several pages: each starts from a clean module
  TestBed.configureTestingModule({
    providers: [
      ...pageProviders(fake, connection, engine),
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
