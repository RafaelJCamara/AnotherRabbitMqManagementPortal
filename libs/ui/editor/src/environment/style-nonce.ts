import type { StyleDocumentLike } from './realm';

const PATCHED = Symbol.for('app.ui-editor.style-nonce');

type CreateElement = (tagName: string, ...rest: unknown[]) => unknown;

interface PatchedCreateElement extends CreateElement {
  [PATCHED]?: true;
}

/** The page nonce the shell writes into `<meta name="csp-nonce">`, or `''`. */
export function readPageNonce(document: StyleDocumentLike): string {
  return document.querySelector('meta[name="csp-nonce"]')?.content ?? '';
}

/** The object up the prototype chain that owns `createElement` (`Document.prototype` in a browser). */
function ownerOfCreateElement(document: object): object | undefined {
  let current: object | null = document;
  while (current !== null) {
    if (Object.prototype.hasOwnProperty.call(current, 'createElement')) {
      return current;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

/**
 * Monaco 0.57 makes its `<style>` elements (theme colours, widget rules) with
 * `document.createElement('style')` and has no nonce option, so under `style-src 'self' 'nonce-N'`
 * they are blocked. This gives every `<style>` element created through `createElement` the page
 * nonce, and touches no other element. With no nonce on the page nothing is patched. Installing
 * twice patches once. The returned function undoes the patch (specs; the application never calls it).
 * Remove the hook when Monaco accepts a nonce (S-04).
 */
export function installStyleNonce(document: StyleDocumentLike): () => void {
  const nonce = readPageNonce(document);
  if (nonce === '') return () => undefined;
  const owner = ownerOfCreateElement(document) as
    | { createElement: PatchedCreateElement }
    | undefined;
  if (owner === undefined || owner.createElement[PATCHED] === true) {
    return () => undefined;
  }
  const original = owner.createElement;
  const patched: PatchedCreateElement = function createStyleWithNonce(
    this: unknown,
    tagName: string,
    ...rest: unknown[]
  ): unknown {
    const element = original.call(this, tagName, ...rest);
    if (typeof tagName === 'string' && tagName.toLowerCase() === 'style') {
      (element as { nonce: string }).nonce = nonce;
    }
    return element;
  };
  patched[PATCHED] = true;
  owner.createElement = patched;
  return () => {
    if (owner.createElement === patched) owner.createElement = original;
  };
}
