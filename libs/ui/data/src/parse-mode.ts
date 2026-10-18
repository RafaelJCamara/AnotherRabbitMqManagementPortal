// "Response `parse` in dev and test builds" (blueprint 3.8): in those builds EngineApi,
// engineResource and the LiveClient check every answer against the zod schema of the contract, so
// drift between engine and UI fails loudly in CI. Production builds skip the cost.
import { InjectionToken, isDevMode } from '@angular/core';

export const ENGINE_PARSE = new InjectionToken<boolean>('ENGINE_PARSE', {
  providedIn: 'root',
  factory: () => isDevMode(),
});
