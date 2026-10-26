import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('ui-editor public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'EDITOR_WORKER_PATHS',
      'EditorLoadError',
      'MONACO_LOADER',
      'createMonacoLoader',
      'installEditorEnvironment',
      'loadMonaco',
    ]);
  });
});
