import { afterEach, describe, expect, it } from 'vitest';

import { installStyleNonce, readPageNonce } from './style-nonce';

interface MadeElement {
  readonly nonce: string;
  readonly tagName: string;
  readonly ownerDocument: Document;
}
interface Creator {
  createElement(tagName: string): MadeElement;
}

// `createElement` is read through Reflect and cast: its DOM typings are overloaded and partly deprecated.
const originalCreateElement: unknown = Reflect.get(
  Document.prototype,
  'createElement',
);
const prototypeCreateElement = (): unknown =>
  Reflect.get(Document.prototype, 'createElement');
const make = (tagName: string, from: object = document): MadeElement =>
  (from as Creator).createElement(tagName);

function setNonceMeta(content: string | null): void {
  document.head.replaceChildren();
  if (content === null) return;
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'csp-nonce');
  meta.setAttribute('content', content);
  document.head.append(meta);
}

afterEach(() => {
  Reflect.set(Document.prototype, 'createElement', originalCreateElement);
  document.head.replaceChildren();
});

describe('installStyleNonce', () => {
  it("M1-46 AC-4 gives Monaco's style elements the page nonce and nothing else", () => {
    setNonceMeta('abc123XYZ');
    installStyleNonce(document);

    const style = make('style');
    const upper = make('STYLE');
    const div = make('div');

    expect(style.nonce).toBe('abc123XYZ');
    expect(upper.nonce).toBe('abc123XYZ');
    expect(div.nonce).toBe('');
    expect(style.tagName).toBe('STYLE');
    expect(div.tagName).toBe('DIV');
  });

  it('M1-46 AC-4 patches nothing, and throws nothing, without a nonce', () => {
    for (const content of [null, '']) {
      setNonceMeta(content);
      let restore = (): void => undefined;
      expect(() => {
        restore = installStyleNonce(document);
      }).not.toThrow();

      expect(prototypeCreateElement()).toBe(originalCreateElement);
      expect(make('style').nonce).toBe('');
      expect(() => {
        restore();
      }).not.toThrow();
    }
  });

  it('patches once however often it is installed, and undoes its patch', () => {
    setNonceMeta('n1');
    const first = installStyleNonce(document);
    const patched = prototypeCreateElement();
    const second = installStyleNonce(document);

    expect(prototypeCreateElement()).toBe(patched);
    expect(patched).not.toBe(originalCreateElement);

    second();
    expect(prototypeCreateElement()).toBe(patched);
    first();
    expect(prototypeCreateElement()).toBe(originalCreateElement);
  });

  it('keeps the arguments and the receiver of createElement', () => {
    setNonceMeta('n2');
    installStyleNonce(document);
    const other = document.implementation.createHTMLDocument('other');

    const element = make('style', other);

    expect(element.ownerDocument).toBe(other);
    expect(element.nonce).toBe('n2');
  });
});

describe('installStyleNonce on a document of its own', () => {
  it('passes every argument on and sets the nonce on the returned style', () => {
    const received: unknown[][] = [];
    const doc = {
      querySelector: () => ({ content: 'own-nonce' }),
      createElement(...args: unknown[]): { nonce?: string } {
        received.push(args);
        return {};
      },
    };

    const restore = installStyleNonce(doc);
    const style = doc.createElement('style', { is: 'x-style' });
    doc.createElement('p', { is: 'x-p' });

    expect(received).toEqual([
      ['style', { is: 'x-style' }],
      ['p', { is: 'x-p' }],
    ]);
    expect(style.nonce).toBe('own-nonce');
    restore();
  });
});

describe('readPageNonce', () => {
  it('reads the csp-nonce meta tag and ignores other metas', () => {
    const viewport = document.createElement('meta');
    viewport.setAttribute('name', 'viewport');
    viewport.setAttribute('content', 'width=1');
    setNonceMeta('zz9');
    document.head.prepend(viewport);
    expect(readPageNonce(document)).toBe('zz9');
    setNonceMeta(null);
    expect(readPageNonce(document)).toBe('');
  });
});
