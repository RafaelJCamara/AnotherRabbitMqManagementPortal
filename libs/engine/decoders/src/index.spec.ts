import { describe, expect, it } from 'vitest';

import * as api from './index.ts';

describe('decoders public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CODEC_MESSAGES',
      'DEFAULT_LIMITS',
      'FORMAT_CODECS',
      'TRANSFORM_CODECS',
      'builtinDecoders',
      'codecPoolOptions',
      'codecWorkerUrl',
      'decodePayload',
      'encodePayload',
      'matchRule',
      'queueMatches',
    ]);
  });
});
