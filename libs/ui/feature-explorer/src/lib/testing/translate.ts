// A strict translate function over the real English file, for specs of plain logic. It fails on a key
// that is not in `en.json`, so a typo in a key is a test failure and not a silent English fallback.
import en from '../../i18n/en.json';
import type { Translate } from '../translate';

type Node = string | { readonly [key: string]: Node };

/** `explorer.a.b` reads `a.b` of the scope file; `{{name}}` is filled from `params`. */
export const translate: Translate = (key, params = {}) => {
  const path = key.replace(/^explorer\./, '').split('.');
  let node: Node = en;
  for (const part of path) {
    const next: Node | undefined =
      typeof node === 'string' ? undefined : node[part];
    if (next === undefined) throw new Error(`Missing translation key ${key}`);
    node = next;
  }
  if (typeof node !== 'string') throw new Error(`${key} is not a string`);
  return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) =>
    String(params[name] ?? `{{${name}}}`),
  );
};
