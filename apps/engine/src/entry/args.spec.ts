import { describe, expect, it } from 'vitest';

import { parseArgs, UsageError } from './args.ts';

const message = (argv: string[]): string => {
  try {
    parseArgs(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error('parseArgs did not throw');
};

describe('command line', () => {
  it('reads every flag', () => {
    expect(
      parseArgs([
        '--mode=local',
        '--port=0',
        '--data-dir=/data',
        '--kek-file=/run/secrets/kek',
        '--ui-dir=/ui',
        '--log-level=debug',
      ]),
    ).toEqual({
      mode: 'local',
      port: 0,
      dataDir: '/data',
      kekFile: '/run/secrets/kek',
      uiDir: '/ui',
      logLevel: 'debug',
    });
  });

  it('needs a mode, and only a known one', () => {
    expect(message([])).toContain('--mode');
    expect(message(['--mode=cloud'])).toContain('--mode');
    expect(parseArgs(['--mode=team']).mode).toBe('team');
    expect(parseArgs(['--mode=desktop']).mode).toBe('desktop');
  });

  it('refuses an unlisted flag, a bare word, a flag without a value and a repeated flag', () => {
    expect(message(['--mode=local', '--listen=0.0.0.0'])).toContain('Unknown');
    expect(message(['--mode=local', 'extra'])).toContain('Unknown');
    expect(message(['--mode=local', '--port'])).toContain('Unknown');
    expect(message(['--mode=local', '--mode=desktop'])).toContain(
      '--mode was given twice',
    );
    expect(message(['--mode', 'local'])).toContain('Unknown');
  });

  it('accepts a port only as plain digits from 0 to 65535', () => {
    for (const port of [
      '',
      '-1',
      '1e3',
      ' 80',
      '0x10',
      '65536',
      '99999',
      '123456',
      'abc',
      '8.5',
    ]) {
      expect(message(['--mode=local', `--port=${port}`])).toContain('--port');
    }
    expect(parseArgs(['--mode=local', '--port=65535']).port).toBe(65_535);
    expect(parseArgs(['--mode=local', '--port=8080']).port).toBe(8080);
  });

  it('rejects an empty path value and an unknown log level', () => {
    expect(message(['--mode=local', '--data-dir='])).toContain('--data-dir');
    expect(message(['--mode=local', '--kek-file='])).toContain('--kek-file');
    expect(message(['--mode=local', '--log-level=loud'])).toContain(
      '--log-level',
    );
  });

  it('names the flag and never echoes a value, which may be the path of a secret', () => {
    const text = message([
      '--mode=local',
      '--kek-file=/very/secret/place/kek.key',
      '--port=abc',
    ]);

    expect(text).toContain('--port');
    expect(text).not.toContain('/very/secret/place');
    expect(text).not.toContain('abc');
  });
});
