import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('kernel public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'AppError',
      'BoundedQueue',
      'BoundedRing',
      'ConfigError',
      'PROBLEM_STATUS',
      'REDACTED',
      'createIdGenerator',
      'createLogger',
      'createManualClock',
      'envVarName',
      'isSensitiveKey',
      'isUlid',
      'loadConfig',
      'problemType',
      'redactText',
      'redactValue',
      'systemClock',
      'toProblem',
      'ulidTimestamp',
      'withCorrelation',
    ]);
  });
});
