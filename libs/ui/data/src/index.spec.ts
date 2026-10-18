import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('ui-data public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_LIVE_CLIENT_CONFIG',
      'ENGINE_INTERCEPTORS',
      'ENGINE_PARSE',
      'EngineApi',
      'EngineProblemError',
      'LIVE_CLIENT_CONFIG',
      'LiveClient',
      'REQUEST_ID_HEADER',
      'authInterceptor',
      'buildEngineRequest',
      'correlationInterceptor',
      'engineResource',
      'isEngineProblem',
      'parseProblem',
      'problemInterceptor',
      'provideEngineData',
      'syntheticProblem',
    ]);
  });
});
