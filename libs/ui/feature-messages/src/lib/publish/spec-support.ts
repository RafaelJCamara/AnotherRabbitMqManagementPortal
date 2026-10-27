// Helpers of the component specs. Never part of the library build.

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
