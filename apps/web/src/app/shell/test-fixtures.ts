// The shell as the specs mount it: the real route table and i18n providers, a fake engine behind
// the real `EngineApi`, and a translation loader chosen by the spec.
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideEngineData } from '@app/ui-data';
import { ENGINE_TRANSPORT } from '@app/ui-platform';
import { FakeEngine, MemoryTransport, waitFor } from '@app/ui-platform/testing';

import { appRoutes } from '../app.routes';
import {
  SCOPE_LOADERS,
  provideI18n,
  type ScopeLoaders,
} from '../i18n/i18n.config';
import { markerLoaders } from '../i18n/test-fixtures';

export interface ShellTestbed {
  readonly engine: FakeEngine;
  readonly harness: RouterTestingHarness;
}

export async function mountShell(
  loaders: ScopeLoaders = markerLoaders(),
): Promise<ShellTestbed> {
  const engine = new FakeEngine();
  TestBed.configureTestingModule({
    providers: [
      provideRouter(appRoutes),
      provideI18n(),
      provideEngineData(),
      { provide: ENGINE_TRANSPORT, useValue: new MemoryTransport(engine) },
      { provide: SCOPE_LOADERS, useValue: loaders },
    ],
  });
  return { engine, harness: await RouterTestingHarness.create() };
}

/**
 * Navigates, then waits until the translation chunks have reached the DOM. They arrive through
 * promises that Angular does not track, so rendering counts as settled when two rounds in a row
 * produce the same markup.
 */
export async function visit(bed: ShellTestbed, url: string): Promise<void> {
  await bed.harness.navigateByUrl(url);
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
