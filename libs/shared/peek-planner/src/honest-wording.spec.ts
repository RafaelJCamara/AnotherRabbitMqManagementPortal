import { describe, expect, it } from 'vitest';

import texts from '../i18n/en/peek-planner.json' with { type: 'json' };
import capsSource from './caps.ts?raw';
import dispositionSource from './disposition.ts?raw';
import dlxHazardSource from './dlx-hazard.ts?raw';
import holdBudgetSource from './hold-budget.ts?raw';
import indexSource from './index.ts?raw';
import limitSource from './limit.ts?raw';
import methodSource from './method.ts?raw';
import planSource from './plan.ts?raw';
import { planPeek } from './plan.ts';
import principalSource from './principal.ts?raw';
import { isRejection } from './rejections.ts';
import rejectionsSource from './rejections.ts?raw';
import { SCENARIOS, build, lookup } from './testing.ts';
import typesSource from './types.ts?raw';
import warningsSource from './warnings.ts?raw';

// The library's own files as text, read through Vite: an isomorphic library may not use node:fs.
// A new source file belongs in this list (the first test checks that the index re-exports match).
const sources: Record<string, string> = {
  './caps.ts': capsSource,
  './disposition.ts': dispositionSource,
  './dlx-hazard.ts': dlxHazardSource,
  './hold-budget.ts': holdBudgetSource,
  './index.ts': indexSource,
  './limit.ts': limitSource,
  './method.ts': methodSource,
  './plan.ts': planSource,
  './principal.ts': principalSource,
  './rejections.ts': rejectionsSource,
  './types.ts': typesSource,
  './warnings.ts': warningsSource,
};

const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const BANNED = /read-only|non-?destructive/i;

describe('AC-19 no prose, no banned claim, every key exists', () => {
  it('AC-19 scans every module the index reaches', () => {
    const imported = [...indexSource.matchAll(/from '(\.\/[a-z-]+)\.ts'/g)].map(
      (match) => `${match[1] ?? ''}.ts`,
    );
    for (const name of imported) {
      expect(Object.keys(sources), name).toContain(name);
    }
    // Modules the index does not export directly are the ones plan.ts imports.
    const used = [...planSource.matchAll(/from '(\.\/[a-z-]+)\.ts'/g)].map(
      (match) => `${match[1] ?? ''}.ts`,
    );
    for (const name of used) expect(Object.keys(sources), name).toContain(name);
  });

  it('AC-19 never calls a read non-destructive or read-only, in code, comments or texts', () => {
    for (const [name, text] of Object.entries(sources)) {
      expect(text, name).not.toMatch(BANNED);
    }
    expect(JSON.stringify(texts)).not.toMatch(BANNED);
    expect(texts.honestLabel.v1).toMatch(/^Side-effect-aware peek/);
  });

  it('AC-19 compares no broker version: the only version-like literal is the conservative era key', () => {
    const literal = /['"](\d+\.\d+(?:[.-][0-9A-Za-z.+-]*)?)['"]/g;
    const found = new Set<string>();
    for (const [name, text] of Object.entries(sources)) {
      for (const match of withoutComments(text).matchAll(literal)) {
        found.add(`${name} ${match[1] ?? ''}`);
      }
    }
    expect([...found]).toEqual(['./limit.ts 4.0-4.2']);
  });

  it('AC-19 never branches on the era or reads the version of the profile', () => {
    for (const [name, text] of Object.entries(sources)) {
      const code = withoutComments(text);
      expect(code, name).not.toMatch(/\bera(\.value)?\s*[!=]==?\s*['"`]/);
      expect(code, name).not.toMatch(/switch\s*\(\s*(era|profile\.era)/);
      expect(code, name).not.toMatch(/versions\.(min|perNode)/);
      expect(code, name).not.toMatch(/\.(major|minor|patch)\b/);
    }
  });

  it('AC-19 answers with keys and codes only: every text key of every answer exists', () => {
    let keys = 0;
    for (const scenario of SCENARIOS) {
      const { request, facts } = build(scenario);
      const result = planPeek(request, facts);
      const collected: string[] = result.warnings.map((w) => w.textKey);
      collected.push(
        isRejection(result) ? result.textKey : result.preview.honestLabelKey,
      );
      for (const key of collected) {
        if (!key.startsWith('peek-planner.')) continue;
        keys += 1;
        expect(lookup(key), `${scenario.name}: ${key}`).toMatch(/\S/);
      }
      expect(JSON.stringify(result), scenario.name).not.toMatch(BANNED);
    }
    expect(keys).toBeGreaterThan(10);
  });
});
