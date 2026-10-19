import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('ui-design public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DENSITIES',
      'ENV_CLASSES',
      'EnvChrome',
      'Gated',
      'MATCH_MEDIA',
      'THEME_PREFERENCES',
      'THEME_STORAGE',
      'THEME_STORAGE_KEYS',
      'ThemeService',
      'VERIFICATION_STATES',
      'VerificationBanner',
      'isDensity',
      'isThemePreference',
      'normalizeEnv',
      'normalizeVerification',
      'parseSourceLink',
      'provideDesignSystem',
    ]);
  });
});
