// ThemeService: which theme and density the UI shows, kept in two attributes of the root element
// (`data-theme`, `data-density`) that tokens.css reacts to. It touches no style attribute and no
// stylesheet, so it works under the strict CSP of the shell (style-src with a nonce).
import { DOCUMENT } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  InjectionToken,
  signal,
} from '@angular/core';

export const THEME_PREFERENCES = [
  'system',
  'light',
  'dark',
  'high-contrast',
] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
/** What is actually shown: `system` is resolved to one of these. */
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

export const isThemePreference = (value: unknown): value is ThemePreference =>
  typeof value === 'string' &&
  (THEME_PREFERENCES as readonly string[]).includes(value);

export const isDensity = (value: unknown): value is Density =>
  typeof value === 'string' && (DENSITIES as readonly string[]).includes(value);

export const THEME_STORAGE_KEYS = {
  theme: 'app.theme',
  density: 'app.density',
} as const;

/** Where the two preferences are remembered. Both calls must never throw. */
export interface ThemeStorage {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

/** `localStorage`, which can be missing or throw (private windows, blocked site data). */
export const THEME_STORAGE = new InjectionToken<ThemeStorage>('THEME_STORAGE', {
  providedIn: 'root',
  factory: (): ThemeStorage => {
    const view = inject(DOCUMENT).defaultView;
    return {
      read: (key) => {
        try {
          return view?.localStorage.getItem(key) ?? null;
        } catch {
          return null;
        }
      },
      write: (key, value) => {
        try {
          view?.localStorage.setItem(key, value);
        } catch {
          // Not remembered; the choice still applies to this session.
        }
      },
    };
  },
});

export interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}
/** `window.matchMedia`, or null where there is none (a test DOM). */
export type MatchMedia = (query: string) => MediaQueryLike | null;

export const MATCH_MEDIA = new InjectionToken<MatchMedia>('MATCH_MEDIA', {
  providedIn: 'root',
  factory: (): MatchMedia => {
    const view = inject(DOCUMENT).defaultView;
    return (query) =>
      view !== null && typeof view.matchMedia === 'function'
        ? view.matchMedia(query)
        : null;
  },
});

/** The token names a third-party widget may read through `ThemeService.token`. */
const TOKEN_NAME = /^--ds-[a-z0-9-]+$/;

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly storage = inject(THEME_STORAGE);
  private readonly matchMedia = inject(MATCH_MEDIA);

  private readonly preferenceState = signal<ThemePreference>(
    this.stored(THEME_STORAGE_KEYS.theme, isThemePreference, 'system'),
  );
  private readonly densityState = signal<Density>(
    this.stored(THEME_STORAGE_KEYS.density, isDensity, 'comfortable'),
  );
  private readonly systemTheme = signal<ResolvedTheme>('light');
  private readonly revisionState = signal(0);

  /** The user's choice, including `system`. */
  readonly preference = this.preferenceState.asReadonly();
  readonly density = this.densityState.asReadonly();
  /**
   * The theme in force. `system` resolves to high contrast when the system asks for it (more
   * contrast or forced colours), else to dark or light; an explicit choice always wins.
   */
  readonly resolved = computed<ResolvedTheme>(() => {
    const choice = this.preferenceState();
    return choice === 'system' ? this.systemTheme() : choice;
  });
  /**
   * Counts how often the theme or density was applied to the page. A widget that does not read
   * CSS variables (a grid, an editor, a chart) re-reads its tokens when this changes.
   */
  readonly revision = this.revisionState.asReadonly();

  constructor() {
    const queries = [
      '(forced-colors: active)',
      '(prefers-contrast: more)',
      '(prefers-color-scheme: dark)',
    ].map((query) => this.matchMedia(query));
    const detect = (): ResolvedTheme => {
      const [forced, contrast, dark] = queries;
      if (forced?.matches === true || contrast?.matches === true) {
        return 'high-contrast';
      }
      return dark?.matches === true ? 'dark' : 'light';
    };
    const onSystemChange = (): void => {
      this.systemTheme.set(detect());
      this.apply();
    };
    this.systemTheme.set(detect());
    for (const query of queries)
      query?.addEventListener('change', onSystemChange);
    inject(DestroyRef).onDestroy(() => {
      for (const query of queries) {
        query?.removeEventListener('change', onSystemChange);
      }
    });
    this.apply();
  }

  /** Throws on a value that is not a preference: settings come from outside the type system. */
  setPreference(value: ThemePreference): void {
    if (!isThemePreference(value)) {
      throw new RangeError(`Unknown theme preference: ${String(value)}`);
    }
    this.preferenceState.set(value);
    this.storage.write(THEME_STORAGE_KEYS.theme, value);
    this.apply();
  }

  setDensity(value: Density): void {
    if (!isDensity(value)) {
      throw new RangeError(`Unknown density: ${String(value)}`);
    }
    this.densityState.set(value);
    this.storage.write(THEME_STORAGE_KEYS.density, value);
    this.apply();
  }

  /** The current value of a design token (`--ds-color-text`), for widgets that cannot read CSS. */
  token(name: string): string {
    if (!TOKEN_NAME.test(name)) {
      throw new RangeError(`Not a design token name: ${name}`);
    }
    const view = this.document.defaultView;
    return (
      view
        ?.getComputedStyle(this.document.documentElement)
        .getPropertyValue(name)
        .trim() ?? ''
    );
  }

  private apply(): void {
    const root = this.document.documentElement;
    root.setAttribute('data-theme', this.resolved());
    root.setAttribute('data-density', this.densityState());
    this.revisionState.update((count) => count + 1);
  }

  private stored<T extends string>(
    key: string,
    isValid: (value: unknown) => value is T,
    fallback: T,
  ): T {
    const value = this.storage.read(key);
    return isValid(value) ? value : fallback;
  }
}
