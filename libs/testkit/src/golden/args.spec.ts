import { describe, expect, it } from 'vitest';

import { modesFor, parseGoldenArgs } from './args.ts';
import { LAVINMQ, allTargets, type RecordTarget } from './record.ts';

const known: RecordTarget[] = allTargets();
const byId = new Map(known.map((target) => [target.id, target]));

describe('record-golden arguments', () => {
  it('records every version and mode by default, and writes', () => {
    const args = parseGoldenArgs([], known);
    expect(args.targets.map((target) => target.id)).toEqual([
      '3.13.7',
      '4.0.9',
      '4.1.8',
      '4.2.9',
      '4.3.6',
      'lavinmq-2.10.2',
    ]);
    expect(args.check).toBe(false);
    expect(args.modes).toBeUndefined();
    expect(args.out).toBeUndefined();
  });

  it('takes --versions, --modes, --check and --out (nx may spell the flag --check=true)', () => {
    const args = parseGoldenArgs(
      [
        '--versions=4.3.6,lavinmq',
        '--modes=stats-off',
        '--check=true',
        '--out=tmp/x',
      ],
      known,
    );
    expect(args.targets).toEqual([byId.get('4.3.6'), LAVINMQ]);
    expect(args.modes).toEqual(['stats-off']);
    expect(args.check).toBe(true);
    expect(args.out).toBe('tmp/x');
    expect(parseGoldenArgs(['--check'], known).check).toBe(true);
    expect(parseGoldenArgs(['--check=false'], known).check).toBe(false);
  });

  it('refuses an unknown version, mode or option instead of recording something else', () => {
    expect(() => parseGoldenArgs(['--versions=9.9.9'], known)).toThrow(
      /unknown version "9.9.9"; known: 3.13.7/,
    );
    expect(() => parseGoldenArgs(['--modes=stats-maybe'], known)).toThrow(
      /unknown mode/,
    );
    expect(() => parseGoldenArgs(['--verions=4.3.6'], known)).toThrow(
      /unknown argument/,
    );
  });

  it('narrows the modes of a target', () => {
    const rabbit = byId.get('4.3.6');
    if (rabbit === undefined) throw new Error('setup');
    expect(modesFor(rabbit, undefined)).toEqual(['stats-on', 'stats-off']);
    expect(modesFor(rabbit, ['stats-off'])).toEqual(['stats-off']);
    expect(modesFor(rabbit, ['default'])).toEqual([]);
    expect(modesFor(LAVINMQ, undefined)).toEqual(['default']);
  });

  it('pins every target by digest', () => {
    for (const target of known) {
      expect(target.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});
