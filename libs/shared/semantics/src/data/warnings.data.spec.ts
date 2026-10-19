import { describe, expect, it } from 'vitest';
import { semanticsRegistry } from '../index.ts';
import { SemanticsGapError } from '../schema.ts';
import warningTexts from '../../i18n/en/warnings.json' with { type: 'json' };
import { warnings } from './warnings.data.ts';

type Texts = Record<string, Record<string, string>>;

const texts: Texts = warningTexts;

/** The 16 ids of fact sheet b.8 step 5, with what the planner does with each. */
const EXPECTED = {
  'W-BUDGET': 'consent',
  'W-313': 'consent',
  'W-TAIL': 'warn',
  'W-OVERLIMIT': 'block',
  'W-DELAY': 'consent',
  'W-REDELIVERED': 'info',
  'W-HOLD': 'warn',
  'W-DROPHEAD': 'consent',
  'W-TTL': 'warn',
  'W-SAC-CQ': 'warn',
  'W-SAC-QQ': 'consent',
  'W-EXCLUSIVE': 'block',
  'W-CRASH': 'info',
  'W-UPGRADED': 'warn',
  'W-MIXED': 'warn',
  'W-STREAM': 'info',
} as const;

describe('W-* warning registry (DC-47)', () => {
  it('has exactly the 16 warnings of the fact sheet', () => {
    expect(warnings.map((entry) => entry.id).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
    expect(warnings).toHaveLength(16);
  });

  for (const [id, severity] of Object.entries(EXPECTED)) {
    it(`${id} is a ${severity} warning whose text key resolves to a text of the same version`, () => {
      const entry = semanticsRegistry.warning(id as keyof typeof EXPECTED);

      expect(entry.severity).toBe(severity);
      expect(entry.textVersion).toBeGreaterThanOrEqual(1);
      expect(entry.textKey).toBe(
        `warnings.${id}.v${String(entry.textVersion)}`,
      );
      const text = texts[id]?.[`v${String(entry.textVersion)}`];
      expect(typeof text, `${entry.textKey} is in warnings.json`).toBe(
        'string',
      );
      expect((text ?? '').length).toBeGreaterThan(30);
    });
  }

  it('the text file has a text for every warning and no text for a warning that does not exist', () => {
    expect(Object.keys(texts).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [id, versions] of Object.entries(texts)) {
      for (const key of Object.keys(versions)) {
        expect(key, id).toMatch(/^v[1-9]\d*$/);
      }
    }
  });

  it('every text uses only {{name}} placeholders, and the ones the planner has to fill are named', () => {
    const placeholders = (id: string): string[] =>
      [...(texts[id]?.v1 ?? '').matchAll(/\{\{(\w+)\}\}/g)].map(
        (match) => match[1] ?? '',
      );

    for (const id of Object.keys(EXPECTED)) {
      const text = texts[id]?.v1 ?? '';
      expect(text.replace(/\{\{\w+\}\}/g, ''), id).not.toMatch(/[{}]/);
    }
    expect(placeholders('W-BUDGET')).toEqual([
      'version',
      'limit',
      'limit',
      'limit',
      'disposition',
    ]);
    expect(placeholders('W-OVERLIMIT')).toContain('minimum');
    expect(placeholders('W-CRASH')).toEqual([]);
    expect(placeholders('W-EXCLUSIVE')).toEqual([]);
  });

  it('the wording never calls a read non-destructive, read-only or safe (DC-15)', () => {
    const banned =
      /non[-\s]?destructive|read[-\s]?only|without (?:any )?side[-\s]effects?|side[-\s]effect[-\s]free|\bsafe peek\b|without breaking|never drops/i;

    for (const [id, versions] of Object.entries(texts)) {
      for (const [version, text] of Object.entries(versions)) {
        expect(text, `${id}.${version}`).not.toMatch(banned);
      }
    }
  });

  it('W-STREAM speaks only about anonymous readers, and W-CRASH only about 4.3 behaviour', () => {
    expect(texts['W-STREAM']?.v1).toContain('anonymous');
    expect(texts['W-CRASH']?.v1).toContain('failed delivery');
  });

  it('an id the registry does not know is a gap', () => {
    expect(() => semanticsRegistry.warning('W-NOPE')).toThrow(
      SemanticsGapError,
    );
  });

  it('every block warning stops a plan and every consent warning needs a confirmation', () => {
    const bySeverity = (severity: string): string[] =>
      warnings
        .filter((entry) => entry.severity === severity)
        .map((entry) => entry.id)
        .sort();

    expect(bySeverity('block')).toEqual(['W-EXCLUSIVE', 'W-OVERLIMIT']);
    expect(bySeverity('consent')).toEqual([
      'W-313',
      'W-BUDGET',
      'W-DELAY',
      'W-DROPHEAD',
      'W-SAC-QQ',
    ]);
  });
});
