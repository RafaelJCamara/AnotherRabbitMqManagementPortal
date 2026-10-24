import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('routing public API', () => {
  // Update this list, and the README, together with every export you add.
  it('M1-02 AC-15 M1-03 AC-12 dlx exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_DLX_LIMITS',
      'DEFAULT_EXCHANGE',
      'DEFAULT_LIMITS',
      'NO_DLX_TRUNCATION',
      'X_MATCH_MODES',
      'alternateExchangeFor',
      'alternateExchangeOf',
      'countHashWords',
      'deadLetterReasons',
      'directRule',
      'fanoutRule',
      'findLoops',
      'headerValuesEqual',
      'headersRule',
      'indexTopology',
      'parseXMatch',
      'routeDefault',
      'routingKeysOf',
      'shareNoteFor',
      'simulate',
      'splitTopicKey',
      'toRoutingNote',
      'topicMatches',
      'topicRule',
      'topicWordsMatch',
      'validateBinding',
    ]);
  });
});
