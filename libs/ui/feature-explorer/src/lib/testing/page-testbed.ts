// Mounts one page of the explorer for a component spec: the real Transloco scope (English), the real
// grid in a DOM that has no layout (so it renders every row it holds), a connection id and the
// model's fake data port. Never part of the library build.
import {
  signal,
  type Provider,
  type Type,
  type WritableSignal,
} from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  createFakeExplorerData,
  type FakeExplorerData,
} from '@app/explorer-model/testing';
import { provideGridRenderAll } from '@app/ui-grid/testing';
import { provideTransloco } from '@jsverse/transloco';

import { EXPLORER_CONNECTION } from '../connection';
import { EXPLORER_DATA } from '../data/explorer-data';
import { provideExplorerScope } from '../explorer-scope';

export interface PageBed<T> {
  readonly fixture: ComponentFixture<T>;
  readonly el: HTMLElement;
  readonly fake: FakeExplorerData;
  readonly connection: WritableSignal<string | null>;
}

/** Providers every explorer page spec needs. */
export function pageProviders(
  fake: FakeExplorerData,
  connection: WritableSignal<string | null>,
): Provider[] {
  return [
    provideTransloco({
      config: { availableLangs: ['en'], defaultLang: 'en', prodMode: true },
    }),
    provideExplorerScope(),
    provideGridRenderAll(),
    { provide: EXPLORER_CONNECTION, useValue: connection },
    { provide: EXPLORER_DATA, useValue: fake },
  ];
}

export async function mountPage<T>(
  type: Type<T>,
  options: {
    readonly fake?: FakeExplorerData;
    readonly cid?: string | null;
    readonly inputs?: Readonly<Record<string, unknown>>;
    readonly providers?: readonly Provider[];
  } = {},
): Promise<PageBed<T>> {
  const fake = options.fake ?? createFakeExplorerData({ autoSnapshot: true });
  const connection = signal<string | null>(
    options.cid === undefined ? 'c1' : options.cid,
  );
  TestBed.resetTestingModule(); // a spec may mount several pages: each starts from a clean module
  TestBed.configureTestingModule({
    providers: [
      ...pageProviders(fake, connection),
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
  return { fixture, el, fake, connection };
}
