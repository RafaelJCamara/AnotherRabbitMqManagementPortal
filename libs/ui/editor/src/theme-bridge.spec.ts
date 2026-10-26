import { TestBed } from '@angular/core/testing';
import { ThemeService } from '@app/ui-design';
import { beforeEach, describe, expect, it } from 'vitest';

import { CodeEditor } from './code-editor.component';
import {
  fakeHost,
  pick,
  provideFakeLoader,
  settle,
} from './editor-spec-support';
import { monacoThemeFor } from './theme-bridge';

beforeEach(() => {
  localStorage.clear();
});

describe('the editor theme bridge', () => {
  it('M1-46 AC-16 maps the app modes to Monaco themes live', async () => {
    const host = fakeHost();
    TestBed.configureTestingModule({ providers: [provideFakeLoader(host)] });
    const fixture = TestBed.createComponent(CodeEditor);
    fixture.componentRef.setInput('ariaLabel', 'Body');
    await settle(fixture);
    expect(host.themes.at(-1)).toBe('vs');

    const theme = TestBed.inject(ThemeService);
    const modes = [
      ['dark', 'vs-dark'],
      ['high-contrast', 'hc-black'],
      ['light', 'vs'],
    ] as const;
    for (const [mode, expected] of modes) {
      theme.setPreference(mode);
      await settle(fixture);
      expect(host.themes.at(-1)).toBe(expected);
    }
    expect(host.editors).toHaveLength(1);
    expect(pick(host.editors, 0).disposed).toBe(0);

    expect(monacoThemeFor('sepia')).toBe('vs');
    expect(monacoThemeFor('')).toBe('vs');
  });
});
