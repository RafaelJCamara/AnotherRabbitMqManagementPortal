import { inject, InjectionToken } from '@angular/core';
import type { ExplorerData } from '@app/explorer-model';
import { EngineApi, LiveClient } from '@app/ui-data';

import { createEngineExplorerData } from './engine-explorer-data';

/**
 * How the pages read the inventory. The engine-backed port by default; a spec provides the model's
 * fake here, or the testbed's port over the fake engine.
 */
export const EXPLORER_DATA = new InjectionToken<ExplorerData>('EXPLORER_DATA', {
  providedIn: 'root',
  factory: () =>
    createEngineExplorerData(inject(EngineApi), inject(LiveClient)),
});
