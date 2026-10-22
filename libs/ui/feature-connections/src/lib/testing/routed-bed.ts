// Mounts the connections routes for a component spec: the real routes and pages under `/connections`, the real
// Transloco scope (English), the real `EngineApi` over a fake engine and a clock the spec moves. Never part of the
// library build.
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ARMING_CLOCK, ENGINE_PARSE, provideEngineData } from '@app/ui-data';
import { ENGINE_TRANSPORT } from '@app/ui-platform';
import { FakeEngine, MemoryTransport } from '@app/ui-platform/testing';
import { vi } from 'vitest';
import type { Provider } from '@angular/core';

import { connectionsRoutes } from '../connections.routes';
import { FakeConnections } from './fake-connections';
import { ManualClock } from './manual-clock';
import { scopeProviders } from './scope';

export interface RoutedBed {
  readonly harness: RouterTestingHarness;
  readonly fake: FakeConnections;
  readonly clock: ManualClock;
  readonly router: Router;
  /** The element the routes render into. */
  readonly el: HTMLElement;
}

/** The timeout of a spec that mounts a routed page and drives it: a few renders and a fake engine. */
export const PAGE_TEST_TIMEOUT_MS = 30_000;

function routeElement(harness: RouterTestingHarness): HTMLElement {
  const el = harness.routeNativeElement;
  if (el === null) throw new Error('nothing is routed');
  return el;
}

export async function mountRouted(
  url: string,
  options: {
    readonly fake?: FakeConnections;
    readonly providers?: readonly Provider[];
  } = {},
): Promise<RoutedBed> {
  const fake = options.fake ?? new FakeConnections().seed('c1');
  const clock = new ManualClock();
  const engine = new FakeEngine({ handler: fake.handler });
  TestBed.resetTestingModule(); // a spec may mount several pages: each starts from a clean module
  TestBed.configureTestingModule({
    providers: [
      ...scopeProviders(),
      provideEngineData(),
      { provide: ENGINE_TRANSPORT, useValue: new MemoryTransport(engine) },
      { provide: ENGINE_PARSE, useValue: true },
      { provide: ARMING_CLOCK, useValue: clock },
      provideRouter([{ path: 'connections', children: connectionsRoutes }]),
      ...(options.providers ?? []),
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const el = routeElement(harness);
  return { harness, fake, clock, router: TestBed.inject(Router), el };
}

/** Re-renders until `check` holds: the scope's words and the engine's answers arrive through promises. */
export async function eventually(
  bed: Pick<RoutedBed, 'harness'>,
  check: () => boolean,
  message = (new Error('where').stack ?? '').split('\n')[2]?.trim() ??
    'the page to show it',
): Promise<void> {
  await vi.waitFor(
    () => {
      bed.harness.detectChanges();
      if (!check()) throw new Error(`waiting for ${message}`);
    },
    { timeout: 10_000 },
  );
}
