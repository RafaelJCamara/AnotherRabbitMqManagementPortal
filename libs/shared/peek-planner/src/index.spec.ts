import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('peek-planner public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'HONEST_LABEL_KEY',
      'PEEK_FEATURE',
      'PLANNER_WARNING_IDS',
      'REASON_CODES',
      'REJECTION_CODES',
      'TEXT_SCOPE',
      'TEXT_VERSION',
      'isHumanInteractive',
      'isRejection',
      'peekPlanner',
      'planPeek',
      'plannerWarning',
      'reasonTextKey',
      'rejectionTextKey',
    ]);
  });
});
