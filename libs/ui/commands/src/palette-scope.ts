// The Transloco scope of the palette (M1-41, R15) and a helper that turns a scope key into text a command can
// hold as its title. The scope is bundled JSON loaded with `import()` (no HTTP: `fetch` is banned outside the
// platform library and the CSP allows scripts from 'self' only); a spec replaces the loader to see the keys.
import { inject, InjectionToken, type Provider } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  TRANSLOCO_SCOPE,
  TranslocoService,
  type ProviderScope,
  type Translation,
} from '@jsverse/transloco';

/** The scope name; its keys read `palette.<path>`. */
export const PALETTE_SCOPE = 'palette';

export const PALETTE_SCOPE_LOADER = new InjectionToken<
  () => Promise<Translation>
>('PALETTE_SCOPE_LOADER', {
  providedIn: 'root',
  factory: () => () => import('./i18n/en.json').then((m) => m.default),
});

/** The scope definition of the palette, with its loader. Call it in an injection context. */
export function paletteScope(): ProviderScope {
  const load = inject(PALETTE_SCOPE_LOADER);
  return { scope: PALETTE_SCOPE, loader: { en: () => load() } };
}

/** Registers the `palette` scope for the views under an injector (the app root provides it). */
export function providePaletteScope(): Provider {
  return {
    provide: TRANSLOCO_SCOPE,
    multi: true,
    useFactory: (): ProviderScope => paletteScope(),
  };
}

/**
 * Text for a command title or category: the key of a scope (relative to it, `commands.open`), read as a
 * signal so the title follows a language change. It is empty until the scope has loaded. Call it in an
 * injection context; a feature passes its own scope definition.
 */
export function scopedText(
  scope: ProviderScope,
  key: string,
  params: Record<string, string | number> = {},
): () => string {
  const text = toSignal(
    inject(TranslocoService).selectTranslate<string>(key, params, scope),
    { initialValue: '' },
  );
  return () => text();
}
