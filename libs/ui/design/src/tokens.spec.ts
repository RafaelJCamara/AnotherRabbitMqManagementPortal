import { describe, expect, it } from 'vitest';

import tailwindPresetCss from './tailwind-preset.css?raw';
import {
  contrastRatio,
  parseCss,
  parseHex,
  px,
  tokensFor,
  type CssRule,
} from './testing/css-tokens';
import tokensCss from './tokens.css?raw';

const rules = parseCss(tokensCss);

const THEMES = {
  light: ":root[data-theme='light']",
  dark: ":root[data-theme='dark']",
  'high-contrast': ":root[data-theme='high-contrast']",
} as const;
type ThemeName = keyof typeof THEMES;

const themeTokens = (theme: ThemeName): Map<string, string> =>
  tokensFor(rules, THEMES[theme]);

const colorNames = (tokens: ReadonlyMap<string, string>): string[] =>
  [...tokens.keys()].filter((name) => name.startsWith('--ds-color-'));

interface Pair {
  readonly label: string;
  readonly foreground: string;
  readonly background: string;
}

/**
 * The text pairs of a theme, found by naming convention so that a token added later is checked
 * without anyone remembering to list it: each `--ds-color-text*` on each `--ds-color-surface*`,
 * and each `--ds-color-on-X` on `--ds-color-X`.
 */
function textPairs(theme: ThemeName): Pair[] {
  const tokens = themeTokens(theme);
  const names = colorNames(tokens);
  const value = (name: string): string => {
    const found = tokens.get(name);
    if (found === undefined) throw new Error(`${theme} has no ${name}`);
    return found;
  };
  const pairs: Pair[] = [];
  for (const text of names.filter((name) =>
    /^--ds-color-text(-|$)/.test(name),
  )) {
    for (const surface of names.filter((name) =>
      /^--ds-color-surface(-|$)/.test(name),
    )) {
      pairs.push({
        label: `${text} on ${surface}`,
        foreground: value(text),
        background: value(surface),
      });
    }
  }
  for (const on of names.filter((name) => name.startsWith('--ds-color-on-'))) {
    const base = `--ds-color-${on.slice('--ds-color-on-'.length)}`;
    pairs.push({
      label: `${on} on ${base}`,
      foreground: value(on),
      background: value(base),
    });
  }
  return pairs;
}

const surfaces = (theme: ThemeName): string[] => {
  const tokens = themeTokens(theme);
  return colorNames(tokens)
    .filter((name) => /^--ds-color-surface(-|$)/.test(name))
    .map((name) => tokens.get(name) ?? '');
};

describe('contrast maths', () => {
  it('matches the published WCAG values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // #767676 on white is the well-known smallest grey that reaches 4.5:1.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#757575', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5);
  });

  it('is symmetric and refuses anything that is not a hex colour', () => {
    expect(contrastRatio('#123456', '#fedcba')).toBe(
      contrastRatio('#fedcba', '#123456'),
    );
    for (const bad of ['red', 'rgb(0 0 0)', 'var(--x)', '#12', '#12345g', '']) {
      expect(() => parseHex(bad)).toThrow();
    }
    expect(() => px('2rem')).toThrow();
    expect(px('24px')).toBe(24);
  });

  it('reads the CSS it is given', () => {
    const parsed: CssRule[] = parseCss(
      '/* c */ a, b { --x: #fff; --y: 1px } @media (x) { c { --z: 2px } }',
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.selectors).toEqual(['a', 'b']);
    expect(parsed[0]?.declarations.get('--y')).toBe('1px');
    expect(parsed[1]?.media).toBe('(x)');
    expect(() => parseCss('a { b }')).toThrow();
    expect(() => parseCss('a { --x: 1')).toThrow();
  });
});

describe('theme tokens', () => {
  it('AC-1 high-contrast: every text token pair is at least 7:1', () => {
    const pairs = textPairs('high-contrast');
    // 6 text tokens on 3 surfaces plus the 10 on-X pairs: a pairing bug cannot pass vacuously.
    expect(pairs.length).toBeGreaterThanOrEqual(28);
    for (const pair of pairs) {
      expect(
        contrastRatio(pair.foreground, pair.background),
        `${pair.label} (${pair.foreground} on ${pair.background})`,
      ).toBeGreaterThanOrEqual(7);
    }
  });

  it('AC-1 light and dark: every text token pair is at least 4.5:1', () => {
    for (const theme of ['light', 'dark'] as const) {
      const pairs = textPairs(theme);
      expect(pairs.length).toBeGreaterThanOrEqual(28);
      for (const pair of pairs) {
        expect(
          contrastRatio(pair.foreground, pair.background),
          `${theme}: ${pair.label}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('AC-1 borders and the focus ring reach 3:1 on every surface, 7:1 in high contrast', () => {
    for (const theme of Object.keys(THEMES) as ThemeName[]) {
      const tokens = themeTokens(theme);
      const minimum = theme === 'high-contrast' ? 7 : 3;
      for (const name of [
        '--ds-color-border-strong',
        '--ds-color-focus-ring',
      ]) {
        const color = tokens.get(name);
        expect(color, `${theme} ${name}`).toBeDefined();
        for (const surface of surfaces(theme)) {
          expect(
            contrastRatio(color ?? '', surface),
            `${theme} ${name} on ${surface}`,
          ).toBeGreaterThanOrEqual(minimum);
        }
      }
    }
  });

  it('every theme sets exactly the same colour tokens, as plain hex values', () => {
    const light = colorNames(themeTokens('light')).sort();
    expect(light.length).toBeGreaterThanOrEqual(32);
    for (const theme of Object.keys(THEMES) as ThemeName[]) {
      const tokens = themeTokens(theme);
      expect(colorNames(tokens).sort(), theme).toEqual(light);
      for (const name of light) {
        expect(
          () => parseHex(tokens.get(name) ?? ''),
          `${theme} ${name}`,
        ).not.toThrow();
      }
      expect(tokens.get('color-scheme'), theme).toBe(
        theme === 'light' ? 'light' : 'dark',
      );
    }
  });

  it('the pairs the checks see are the ones in the file', () => {
    // A mutant that renamed `--ds-color-text` or dropped a surface would shrink the pair list
    // silently; pin the names the safety components rely on.
    const names = colorNames(themeTokens('high-contrast'));
    for (const required of [
      '--ds-color-text',
      '--ds-color-surface',
      '--ds-color-on-env-prod',
      '--ds-color-env-prod',
      '--ds-color-on-warning',
      '--ds-color-on-danger',
      '--ds-color-focus-ring',
    ]) {
      expect(names).toContain(required);
    }
  });
});

describe('density tokens', () => {
  const comfortable = tokensFor(rules, ':root');
  const compact = tokensFor(rules, ":root[data-density='compact']");

  it('AC-1 comfortable density: every target and the row height are at least 24 px', () => {
    const targets = [...comfortable.keys()].filter(
      (name) => name.startsWith('--ds-target-') || name === '--ds-row-height',
    );
    expect(targets).toEqual(
      expect.arrayContaining(['--ds-target-size', '--ds-row-height']),
    );
    for (const name of targets) {
      expect(px(comfortable.get(name) ?? ''), name).toBeGreaterThanOrEqual(24);
    }
    expect(tokensFor(rules, ":root[data-density='comfortable']")).toEqual(
      comfortable,
    );
  });

  it('compact density keeps 22 to 24 px rows, 12 to 13 px type and 24 px targets', () => {
    expect(px(compact.get('--ds-row-height') ?? '')).toBeGreaterThanOrEqual(22);
    expect(px(compact.get('--ds-row-height') ?? '')).toBeLessThanOrEqual(24);
    expect(px(compact.get('--ds-font-size') ?? '')).toBeGreaterThanOrEqual(12);
    expect(px(compact.get('--ds-font-size') ?? '')).toBeLessThanOrEqual(13);
    expect(px(compact.get('--ds-target-size') ?? '')).toBeGreaterThanOrEqual(
      24,
    );
  });

  it('compact density is opt-in: the default tokens are the comfortable ones', () => {
    expect(tokensFor(rules, ':root').get('--ds-row-height')).toBe('32px');
    expect(
      rules.some((rule) => rule.selectors.includes(':root[data-density]')),
    ).toBe(false);
  });

  it('reduced motion switches animation off', () => {
    const reduced = rules.find(
      (rule) => rule.media === '(prefers-reduced-motion: reduce)',
    );
    expect(reduced?.declarations.get('--ds-motion-duration')).toBe('0ms');
  });
});

describe('tailwind preset', () => {
  const preset = parseCss(tailwindPresetCss).find(
    (rule) => rule.selectors[0] === '@theme inline',
  );
  const defined = new Set(themeTokens('light').keys());
  for (const name of tokensFor(rules, ':root').keys()) defined.add(name);

  it('maps only tokens that exist, and every colour token', () => {
    expect(preset).toBeDefined();
    const mapped = new Map(preset?.declarations);
    for (const [name, value] of mapped) {
      const target = /^var\((--ds-[a-z0-9-]+)\)$/.exec(value)?.[1];
      expect(target, `${name}: ${value}`).toBeDefined();
      expect(
        defined.has(target ?? ''),
        `${name} -> ${target ?? 'nothing'}`,
      ).toBe(true);
    }
    const mappedTargets = new Set(
      [...mapped.values()].map(
        (value) => /\((--ds-[a-z0-9-]+)\)/.exec(value)?.[1],
      ),
    );
    for (const color of colorNames(themeTokens('light'))) {
      expect(mappedTargets.has(color), `${color} is not mapped`).toBe(true);
    }
  });
});
