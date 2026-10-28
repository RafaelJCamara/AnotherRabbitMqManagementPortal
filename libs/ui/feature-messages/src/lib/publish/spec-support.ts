// Helpers of the component specs. Never part of the library build.
import en from '../../i18n/en.json';

import type { Translate } from '../translate';

/**
 * The texts and the attribute values on the page that are still a translation key. A key that does not exist (or
 * is the wrong one) shows itself, so a page of real words has none.
 */
export function leakedKeys(root: Element): string[] {
  const found: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = squash(node.textContent);
      if (/\bpublish\.[A-Za-z]/.test(text)) found.push(text);
      return;
    }
    if (node instanceof Element) {
      for (const name of ['aria-label', 'title', 'placeholder', 'alt']) {
        const value = node.getAttribute(name);
        if (value !== null && /\bpublish\.[A-Za-z]/.test(value)) {
          found.push(value);
        }
      }
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  return found;
}

export const squash = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/**
 * The real English file as a `Translate`: a key that is not in it throws, so a wrong or missing key fails the spec
 * that asked for it, and `{{name}}` is filled from the params.
 */
export const english: Translate = (key, params) => {
  let node: unknown = { publish: en };
  for (const part of key.split('.')) {
    node =
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  if (typeof node !== 'string') throw new Error(`no English text for ${key}`);
  return node.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    String(params?.[name] ?? ''),
  );
};

/** Every text under a key prefix of the English file, with its path. */
export function englishTexts(prefix: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') out.push([path, node]);
    else if (typeof node === 'object' && node !== null) {
      for (const [name, value] of Object.entries(node)) {
        walk(value, `${path}.${name}`);
      }
    }
  };
  walk({ publish: en }, '');
  return out
    .map(([path, text]): [string, string] => [path.slice(1), text])
    .filter(([path]) => path.startsWith(prefix));
}

/** Words the honest-wording rule of the product keeps out of what is said about a publish (DC-15, R5). */
export const BANNED_WORDS =
  /read-only|non-destructive|\bsafe\b|\bundo|deliver|consum/i;
