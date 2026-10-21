// Test support for the i18n of the shell: the real English files, and a loader set that answers
// `[[scope.key]]` for every leaf, so a spec can see exactly which key a view asked for.
import type { ComponentFixture } from '@angular/core/testing';
import { waitFor } from '@app/ui-platform/testing';
import type { Translation } from '@jsverse/transloco';

import shell from './en/shell.json';
import status from './en/status.json';
import system from './en/system.json';
import type { ScopeLoaders } from './i18n.config';
import { SCOPE_NAMES, type ScopeName } from './scopes';

export const ENGLISH: Readonly<Record<ScopeName, Translation>> = {
  shell,
  status,
  system,
};

function mark(tree: Translation, path: string): Translation {
  const out: Translation = {};
  for (const [name, value] of Object.entries(tree)) {
    const here = `${path}.${name}`;
    out[name] =
      typeof value === 'string'
        ? `[[${here}]]`
        : mark(value as Translation, here);
  }
  return out;
}

function leafKeys(tree: Translation, path: string): string[] {
  return Object.entries(tree).flatMap(([name, value]) =>
    typeof value === 'string'
      ? [`${path}.${name}`]
      : leafKeys(value as Translation, `${path}.${name}`),
  );
}

/** Every key of the English files, as `scope.path`. */
export function englishKeys(): string[] {
  return SCOPE_NAMES.flatMap((name) => leafKeys(ENGLISH[name], name));
}

/** Loaders that answer the English files with each text replaced by `[[key]]`. */
export function markerLoaders(): ScopeLoaders {
  const loaders = {} as Record<ScopeName, () => Promise<Translation>>;
  for (const name of SCOPE_NAMES) {
    loaders[name] = () => Promise.resolve(mark(ENGLISH[name], name));
  }
  return loaders;
}

/** Loaders that answer the English files as they are. */
export function englishLoaders(): ScopeLoaders {
  const loaders = {} as Record<ScopeName, () => Promise<Translation>>;
  for (const name of SCOPE_NAMES) {
    loaders[name] = () => Promise.resolve(ENGLISH[name]);
  }
  return loaders;
}

/**
 * Translations arrive through promises that Angular does not track, so a view is settled when
 * two rounds in a row produce the same markup.
 */
export async function settle(
  fixture: ComponentFixture<unknown>,
): Promise<void> {
  let previous = '';
  await waitFor(() => {
    fixture.detectChanges();
    const now = (fixture.nativeElement as HTMLElement).outerHTML;
    const stable = now === previous;
    previous = now;
    return stable;
  }, 'the translations to settle');
}

/** Every visible string of a DOM subtree: text nodes and the attributes screen readers read. */
export function visibleStrings(root: Element): string[] {
  const strings: string[] = [];
  const attributes = ['aria-label', 'title', 'placeholder', 'alt'];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').trim();
      if (text !== '') strings.push(text);
      return;
    }
    if (node instanceof Element) {
      for (const name of attributes) {
        const value = node.getAttribute(name);
        if (value !== null && value.trim() !== '') strings.push(value.trim());
      }
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  return strings;
}
