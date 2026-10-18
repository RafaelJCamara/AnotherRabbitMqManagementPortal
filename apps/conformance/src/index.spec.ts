import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('conformance public API', () => {
  it('exports no code', () => {
    expect(Object.keys(api)).toEqual([]);
  });
});
