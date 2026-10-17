import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('broker-lab public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual(['BROKER_LAB_DIR']);
  });

  it('points at the folder with the Dockerfile', () => {
    expect(existsSync(join(api.BROKER_LAB_DIR, 'Dockerfile'))).toBe(true);
  });
});
