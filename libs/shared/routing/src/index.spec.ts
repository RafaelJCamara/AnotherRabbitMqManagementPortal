import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('routing public API', () => {
  // Update this list, and the README, together with every export you add.
  it('M1-02 AC-15 exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_EXCHANGE',
      'DEFAULT_LIMITS',
      'X_MATCH_MODES',
      'alternateExchangeFor',
      'alternateExchangeOf',
      'countHashWords',
      'directRule',
      'fanoutRule',
      'findLoops',
      'headerValuesEqual',
      'headersRule',
      'indexTopology',
      'parseXMatch',
      'routeDefault',
      'routingKeysOf',
      'simulate',
      'splitTopicKey',
      'topicMatches',
      'topicRule',
      'topicWordsMatch',
      'validateBinding',
    ]);
  });
});
