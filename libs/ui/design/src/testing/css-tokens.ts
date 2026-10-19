// Test support for the token files: a small CSS reader and the WCAG 2.x contrast maths. Only the
// specs use it. It understands exactly what `tokens.css` and `tailwind-preset.css` contain (rules
// and one level of at-rule blocks, custom properties as declarations) and throws on anything else,
// so a token written in a form the checks cannot read fails the build instead of passing unchecked.

export interface CssRule {
  /** The selector list, split at commas and trimmed. */
  readonly selectors: readonly string[];
  /** The condition of the enclosing `@media`, or null for a top-level rule. */
  readonly media: string | null;
  readonly declarations: ReadonlyMap<string, string>;
}

const stripComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, '');

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const part of body.split(';')) {
    const text = part.trim();
    if (text === '') continue;
    const colon = text.indexOf(':');
    if (colon < 1) throw new Error(`Unreadable declaration: ${text}`);
    declarations.set(text.slice(0, colon).trim(), text.slice(colon + 1).trim());
  }
  return declarations;
}

/** Index of the `}` that closes the `{` at `open`. */
function closingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('Unbalanced braces in CSS.');
}

function parseBlock(css: string, media: string | null, out: CssRule[]): void {
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor);
    if (open === -1) {
      if (css.slice(cursor).trim() !== '') throw new Error('Trailing CSS.');
      return;
    }
    const prelude = css.slice(cursor, open).trim();
    const close = closingBrace(css, open);
    const body = css.slice(open + 1, close);
    if (prelude.startsWith('@media')) {
      if (media !== null) throw new Error('Nested @media is not supported.');
      parseBlock(body, prelude.slice('@media'.length).trim(), out);
    } else if (prelude.startsWith('@')) {
      // @theme and friends: the body is a declaration list.
      out.push({
        selectors: [prelude],
        media,
        declarations: parseDeclarations(body),
      });
    } else {
      out.push({
        selectors: prelude.split(',').map((selector) => selector.trim()),
        media,
        declarations: parseDeclarations(body),
      });
    }
    cursor = close + 1;
  }
}

export function parseCss(source: string): CssRule[] {
  const rules: CssRule[] = [];
  parseBlock(stripComments(source), null, rules);
  return rules;
}

/** The declarations of every top-level rule whose selector list contains `selector` exactly. */
export function tokensFor(
  rules: readonly CssRule[],
  selector: string,
): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of rules) {
    if (rule.media === null && rule.selectors.includes(selector)) {
      for (const [name, value] of rule.declarations) merged.set(name, value);
    }
  }
  return merged;
}

export type Rgb = readonly [number, number, number];

/** `#rgb` or `#rrggbb`. Anything else (named colours, functions, `var()`) is refused. */
export function parseHex(value: string): Rgb {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match?.[1]) throw new Error(`Not a hex colour: ${value}`);
  const hex = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** WCAG 2.x relative luminance of an sRGB colour. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2.x contrast ratio, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(parseHex(a));
  const second = relativeLuminance(parseHex(b));
  const [light, dark] = first >= second ? [first, second] : [second, first];
  return (light + 0.05) / (dark + 0.05);
}

/** `24px` to 24. Refuses any other unit. */
export function px(value: string): number {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
  if (!match?.[1]) throw new Error(`Not a px length: ${value}`);
  return Number(match[1]);
}
