// Marker translations for the i18n spec: the English file with each text replaced by `[[palette.<path>]]`, so a
// spec can see which key a view asked for, and the strings a DOM shows. Never part of the library build.
import type { Translation } from '@jsverse/transloco';

import en from '../i18n/en.json';

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

/** The loader to provide as `PALETTE_SCOPE_LOADER`. */
export const markedPaletteScope = (): Promise<Translation> =>
  Promise.resolve(mark(en as Translation, 'palette'));

/** Every key of the English file, as `palette.<path>`. */
export const paletteKeys = (): string[] => leafKeys(en, 'palette');

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
