// Small DOM helpers of the connections component specs. Never part of the library build.

export const squash = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** The first element matching `selector` whose text contains `text`; throws when there is none. */
export function byText(
  root: ParentNode,
  selector: string,
  text: string,
): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>(selector)].find((el) =>
    squash(el.textContent).includes(text),
  );
  if (!found) throw new Error(`no ${selector} containing "${text}"`);
  return found;
}

export const exists = (
  root: ParentNode,
  selector: string,
  text: string,
): boolean =>
  [...root.querySelectorAll<HTMLElement>(selector)].some((el) =>
    squash(el.textContent).includes(text),
  );

/** Types into an input as a person would: sets the value and fires `input`. */
export function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function press(target: Element, key: string): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** The `dt` and `dd` pairs of a description list, by term. */
export function definitions(root: ParentNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dt of root.querySelectorAll('dt')) {
    out[squash(dt.textContent)] = squash(dt.nextElementSibling?.textContent);
  }
  return out;
}
