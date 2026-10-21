// Mounts the explorer's routed grid page at an address, as the web shell would: the routes of the feature
// (without their lazy loading) under a router, the connection a signal, the inventory from the model's fake
// and everything else from the fake workspace behind `EngineApi`. Never part of the library build.
import { signal, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import {
  createFakeExplorerData,
  type FakeExplorerData,
} from '@app/explorer-model/testing';
import { FakeEngine } from '@app/ui-platform/testing';

import { InventoryRoute } from '../grid/inventory-route.component';
import { FakeWorkspace } from './fake-workspace';
import { pageProviders } from './page-testbed';

export async function mountRoute(
  url: string,
  options: {
    readonly fake?: FakeExplorerData;
    readonly workspace?: FakeWorkspace;
    readonly cid?: string | null;
    readonly providers?: readonly Provider[];
  } = {},
) {
  const fake = options.fake ?? createFakeExplorerData({ autoSnapshot: true });
  const workspace = options.workspace ?? new FakeWorkspace();
  const engine = new FakeEngine({ handler: workspace.handler });
  const connection = signal<string | null>(
    options.cid === undefined ? 'c1' : options.cid,
  );
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      ...pageProviders(fake, connection, engine),
      provideRouter(
        (['queues', 'exchanges', 'connections', 'bindings'] as const).map(
          (kind) => ({
            path: kind,
            component: InventoryRoute,
            data: { kind },
          }),
        ),
      ),
      ...(options.providers ?? []),
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const el = harness.routeNativeElement;
  if (el === null) throw new Error('nothing is routed');
  return {
    harness,
    el,
    fake,
    workspace,
    engine,
    connection,
    router: TestBed.inject(Router),
  };
}
