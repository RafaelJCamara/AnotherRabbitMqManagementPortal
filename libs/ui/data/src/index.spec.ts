import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('ui-data public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'ARMING_CLOCK',
      'ArmingStore',
      'ConnectionDirectory',
      'DEFAULT_LIVE_CLIENT_CONFIG',
      'ENGINE_INTERCEPTORS',
      'ENGINE_PARSE',
      'EngineApi',
      'EngineProblemError',
      'LIVE_CLIENT_CONFIG',
      'LiveClient',
      'PROD_LOCK_SOURCE',
      'REQUEST_ID_HEADER',
      'authInterceptor',
      'buildEngineRequest',
      'correlationInterceptor',
      'engineResource',
      'isEngineProblem',
      'lockGate',
      'parseProblem',
      'problemInterceptor',
      'provideEngineData',
      'syntheticProblem',
    ]);
  });
});
