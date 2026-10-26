import { computed, inject, Injectable } from '@angular/core';
import { ThemeService } from '@app/ui-design';

import type { EditorThemeName } from './facade';

/**
 * The app's resolved theme as Monaco's built-in theme. High contrast maps to the dark one; a mode
 * this table does not know falls back to the light theme. (Pushing the app's own tokens into a
 * Monaco theme is the M5 theming work package.)
 */
export function monacoThemeFor(mode: string): EditorThemeName {
  switch (mode) {
    case 'dark':
      return 'vs-dark';
    case 'high-contrast':
      return 'hc-black';
    default:
      return 'vs';
  }
}

@Injectable({ providedIn: 'root' })
export class EditorThemeBridge {
  private readonly theme = inject(ThemeService);
  /** Follows `ThemeService` live; an editor applies it without being recreated. */
  readonly name = computed(() => monacoThemeFor(this.theme.resolved()));
}
