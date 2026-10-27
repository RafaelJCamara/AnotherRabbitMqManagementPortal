// The studio mounted for a component spec: the real routes, the real English scope, a fake editor host and a
// draft store the spec can seed. Never part of the library build.
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ConnectionIdSchema, type ConnectionId } from '@app/contracts';
import { EditorLoadError, MONACO_LOADER } from '@app/ui-editor';
import {
  fakeHost,
  provideFakeLoader,
  type FakeHost,
} from '@app/ui-editor/testing';
import { provideTransloco } from '@jsverse/transloco';
import { expect, vi } from 'vitest';

import { DraftStore } from './draft-store';
import { messagesRoutesFor } from './publish.routes';

export interface Bed {
  readonly harness: RouterTestingHarness;
  readonly host: FakeHost;
  readonly store: DraftStore;
  readonly el: HTMLElement;
}

export async function settle(harness: RouterTestingHarness): Promise<void> {
  for (let round = 0; round < 6; round++) {
    harness.detectChanges();
    await (harness.fixture as ComponentFixture<unknown>).whenStable();
    await Promise.resolve();
  }
}

export async function mount(
  url: string,
  options: {
    cid?: ConnectionId | null;
    loadFails?: boolean;
    seed?: (store: DraftStore) => void;
  } = {},
): Promise<Bed> {
  const host = fakeHost();
  const cid =
    options.cid === undefined ? ConnectionIdSchema.parse('c1') : options.cid;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideTransloco({
        config: { availableLangs: ['en'], defaultLang: 'en', prodMode: true },
      }),
      options.loadFails === true
        ? {
            provide: MONACO_LOADER,
            useValue: {
              load: () =>
                Promise.reject(
                  new EditorLoadError('not-bundled', 'no editor in this build'),
                ),
            },
          }
        : provideFakeLoader(host),
      provideRouter([
        {
          path: 'c/:cid/publish',
          children: messagesRoutesFor(() => signal(cid)),
        },
      ]),
    ],
  });
  const harness = await RouterTestingHarness.create();
  options.seed?.(TestBed.inject(DraftStore));
  await harness.navigateByUrl(url);
  await settle(harness);
  // The words arrive after the router settles (the scope is a lazy chunk): wait for the page, not for a guess.
  if (cid !== null) {
    await vi.waitFor(
      () => {
        harness.detectChanges();
        expect(harness.routeNativeElement?.querySelector('h1')).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    await settle(harness);
  }
  return {
    harness,
    host,
    store: TestBed.inject(DraftStore),
    el: harness.routeNativeElement ?? document.body,
  };
}

export function typeInto(el: Element | null, value: string): void {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement))
    throw new Error('no input');
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export const field = (bed: Bed, id: string): HTMLInputElement => {
  const el = bed.el.querySelector<HTMLInputElement>(`#${id}`);
  if (el === null) throw new Error(`no field ${id}`);
  return el;
};
