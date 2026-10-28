// The studio mounted for a component spec: the real routes, the real English scope, a fake editor host and a
// draft store the spec can seed. Never part of the library build.
import { signal, type Provider, type Type } from '@angular/core';
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
import { ARMING_CLOCK } from '@app/ui-data';
import { provideTransloco } from '@jsverse/transloco';
import { expect, vi } from 'vitest';

import type { PublishDraft } from './draft';
import { DraftStore } from './draft-store';
import { FakeApi, provideFakeApi, type FakeApiHandlers } from './fake-api';
import { profileFixture } from './profile-fixture';
import { messagesRoutesFor } from './publish.routes';

export interface Bed {
  readonly harness: RouterTestingHarness;
  readonly host: FakeHost;
  readonly store: DraftStore;
  readonly api: FakeApi;
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
    /** What the fake engine answers; the default is one development connection `c1` and no publish handlers. */
    engine?: FakeApiHandlers;
    api?: FakeApi;
  } = {},
): Promise<Bed> {
  const host = fakeHost();
  const api =
    options.api ??
    new FakeApi({ profiles: [profileFixture('c1')], ...options.engine });
  const cid =
    options.cid === undefined ? ConnectionIdSchema.parse('c1') : options.cid;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideFakeApi(api),
      // No timer runs behind a spec: the arming window is counted from the engine's answer and never fires.
      {
        provide: ARMING_CLOCK,
        useValue: { now: () => Date.now(), after: () => () => undefined },
      },
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
    api,
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

/** Seeds the draft of `c1` with these fields before the page opens. */
export const withDraft =
  (patch: Partial<PublishDraft>) =>
  (store: DraftStore): void => {
    store.draft('c1').update((draft) => ({ ...draft, ...patch }));
  };

/** A draft the contract accepts: the default exchange and a queue name. */
export const VALID = { exchange: '', routingKey: 'orders' } as const;

/** The Send button (the control inside `<app-gated>`). */
export function sendButton(bed: Bed): HTMLButtonElement {
  const el = bed.el.querySelector<HTMLButtonElement>('.send button.control');
  if (el === null) throw new Error('no Send button');
  return el;
}

/** Waits, settling the page, until `check` holds. */
export async function until(
  bed: Bed,
  check: () => boolean,
  what: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      await settle(bed.harness);
      expect(check(), what).toBe(true);
    },
    { timeout: 5_000 },
  );
}

/** A component under test with the real English scope: waits until its words have arrived. */
export async function mountHost<T>(
  type: Type<T>,
  providers: Provider[] = [],
): Promise<ComponentFixture<T>> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideTransloco({
        config: { availableLangs: ['en'], defaultLang: 'en', prodMode: true },
      }),
      ...providers,
    ],
  });
  const fixture = TestBed.createComponent(type);
  await vi.waitFor(
    () => {
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).textContent.trim(),
      ).not.toBe('');
    },
    { timeout: 10_000 },
  );
  await fixture.whenStable();
  return fixture;
}
