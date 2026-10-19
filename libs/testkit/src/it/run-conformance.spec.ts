import { describe, expect, it } from 'vitest';
import {
  blocks,
  parse,
  summarise,
  vitestArgs,
  vitestEnv,
} from './run-conformance.ts';

const KNOWN = ['3.13.7', '4.0.9', '4.1.8', '4.2.9', '4.3.6'];

describe('conformance:test launcher', () => {
  it('AC-2 reads --versions, --grep, --shard and --strict, and makes 4.0.9 non-blocking by default', () => {
    expect(
      parse(
        [
          '--versions=4.2.9,4.3.6',
          '--grep=CF-SMOKE',
          '--shard=2/4',
          '--strict',
        ],
        KNOWN,
      ),
    ).toEqual({
      versions: ['4.2.9', '4.3.6'],
      grep: 'CF-SMOKE',
      shard: '2/4',
      strict: true,
      nonBlocking: ['4.0.9'],
    });
    expect(parse([], KNOWN)).toEqual({
      versions: undefined,
      grep: undefined,
      shard: undefined,
      strict: false,
      nonBlocking: ['4.0.9'],
    });
  });

  it('lets --non-blocking name other versions, or none', () => {
    expect(parse(['--non-blocking=3.13.7,4.0.9'], KNOWN).nonBlocking).toEqual([
      '3.13.7',
      '4.0.9',
    ]);
    expect(parse(['--non-blocking='], KNOWN).nonBlocking).toEqual([]);
  });

  it('refuses a version the lab does not pin, an unknown option, a shard or a pattern that is not plain', () => {
    expect(() => parse(['--versions=9.9.9'], KNOWN)).toThrow(
      'not a lab version',
    );
    expect(() => parse(['--non-blocking=9.9.9'], KNOWN)).toThrow(
      'not a lab version',
    );
    expect(() => parse(['--loose'], KNOWN)).toThrow('unknown option');
    expect(() => parse(['--shard=0/4'], KNOWN)).toThrow('--shard');
    expect(() => parse(['--shard=a/b'], KNOWN)).toThrow('--shard');
    expect(() => parse(['--grep=a;rm -rf /'], KNOWN)).toThrow('--grep');
  });

  it('AC-2 summarises the results the specs reported, with every one that is not a pass', () => {
    const lines = [
      {
        cfId: 'CF-A-01',
        cellId: 'SEM-1',
        version: '4.3.6',
        verdict: 'pass',
        reasons: [],
      },
      {
        cfId: 'CF-B-01',
        cellId: null,
        version: '4.3.6',
        verdict: 'unverified',
        reasons: ['no evidence', 'no live run'],
      },
      {
        cfId: 'CF-C-01',
        cellId: 'SEM-3',
        version: '4.2.9',
        verdict: 'fail',
        reasons: ['the live run differs'],
      },
    ].map((line) => JSON.stringify(line));

    expect(summarise(`${lines.join('\n')}\n`)).toBe(
      [
        'conformance:test: 3 result(s): 1 pass, 1 fail, 1 unverified',
        '  unverified CF-B-01 on 4.3.6 (cell none): no evidence; no live run',
        '  fail CF-C-01 on 4.2.9 (cell SEM-3): the live run differs',
      ].join('\n'),
    );
  });

  it('AC-2 hands --grep to vitest as the test-name filter and --shard as the shard, and nothing else', () => {
    const none = parse([], KNOWN);
    const both = parse(['--grep=CF-SMOKE', '--shard=1/4'], KNOWN);

    expect(vitestArgs(none, [])).toEqual([
      'run',
      '--config',
      'apps/conformance/vitest.config.mts',
    ]);
    expect(vitestArgs(both, ['src/cells'])).toEqual([
      'run',
      '--config',
      'apps/conformance/vitest.config.mts',
      '-t',
      'CF-SMOKE',
      '--shard',
      '1/4',
      'src/cells',
    ]);
  });

  it('AC-2 passes the broker, the report file and --strict to the specs through the environment', () => {
    const lenient = vitestEnv(
      parse([], KNOWN),
      { LAB_BROKER: '{}' },
      '/tmp/r.jsonl',
    );
    const strict = vitestEnv(parse(['--strict'], KNOWN), {}, '/tmp/r.jsonl');

    expect(lenient).toEqual({
      LAB_BROKER: '{}',
      CONFORMANCE_REPORT: '/tmp/r.jsonl',
    });
    expect(strict).toEqual({
      CONFORMANCE_REPORT: '/tmp/r.jsonl',
      CONFORMANCE_STRICT: '1',
    });
  });

  it('a failing version fails the command unless it is named non-blocking', () => {
    expect(blocks('4.3.6', ['4.0.9'])).toBe(true);
    expect(blocks('4.0.9', ['4.0.9'])).toBe(false);
    expect(blocks('4.0.9', [])).toBe(true);
  });
});
