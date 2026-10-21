// The shell as the specs mount it: the real route table and i18n providers, a fake engine behind
// the real `EngineApi` that stores layouts per connection, a manual clock for the save delay and
// a translation loader chosen by the spec.
import { ApplicationRef, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { FakeEngine } from '@app/ui-platform/testing';
import { waitFor } from '@app/ui-platform/testing';

import { appRoutes } from '../app.routes';
import {
  SCOPE_LOADERS,
  provideI18n,
  type ScopeLoaders,
} from '../i18n/i18n.config';
import { markerLoaders } from '../i18n/test-fixtures';
import type { Viewport } from './layout/fit-layout';
import {
  LayoutBackend,
  ManualTimer,
  layoutProviders,
} from './layout/layout-fixtures';

export interface ShellTestbed {
  readonly engine: FakeEngine;
  readonly layouts: LayoutBackend;
  readonly timer: ManualTimer;
  readonly harness: RouterTestingHarness;
}

export async function mountShell(
  loaders: ScopeLoaders = markerLoaders(),
  layouts: LayoutBackend = new LayoutBackend(),
  viewport?: Viewport,
  extra: readonly Provider[] = [],
): Promise<ShellTestbed> {
  const timer = new ManualTimer();
  TestBed.configureTestingModule({
    providers: [
      provideRouter(appRoutes),
      provideI18n(),
      ...layoutProviders(layouts, timer, viewport),
      { provide: SCOPE_LOADERS, useValue: loaders },
      ...extra,
    ],
  });
  return {
    engine: layouts.engine,
    layouts,
    timer,
    harness: await RouterTestingHarness.create(),
  };
}

/**
 * Navigates, then waits until the translation chunks have reached the DOM. They arrive through
 * promises that Angular does not track, so rendering counts as settled when two rounds in a row
 * produce the same markup.
 */
export async function visit(bed: ShellTestbed, url: string): Promise<void> {
  await bed.harness.navigateByUrl(url);
  await settleShell(bed);
}

/** Waits until what is routed has stopped changing (after a visit, or after the spec acted). */
export async function settleShell(bed: ShellTestbed): Promise<void> {
  // Navigations and requests are pending tasks of the application; wait for them first.
  await TestBed.inject(ApplicationRef).whenStable();
  let previous = '';
  await waitFor(() => {
    bed.harness.detectChanges();
    const now = bed.harness.routeNativeElement?.outerHTML ?? '';
    const stable = now === previous;
    previous = now;
    return stable;
  }, 'the translations to settle');
}

export function routed(bed: ShellTestbed): HTMLElement {
  const host = bed.harness.routeNativeElement;
  if (host === null) throw new Error('nothing is routed');
  return host;
}
