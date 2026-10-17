import { describe, expect, it } from 'vitest';

import { parseOptions } from './broker-lab-cli.ts';

describe('broker-lab command line', () => {
  it('reads comma separated options', () => {
    const options = parseOptions(
      ['--versions=3.13.7,4.3.6', '--nodes=1'],
      ['versions', 'nodes'],
    );
    expect(options.get('versions')).toEqual(['3.13.7', '4.3.6']);
    expect(options.get('nodes')).toEqual(['1']);
  });

  it('rejects an unknown option so a typo cannot pass silently', () => {
    expect(() => parseOptions(['--version=4.3.6'], ['versions'])).toThrow(
      /Unknown argument "--version=4\.3\.6"/,
    );
    expect(() => parseOptions(['4.3.6'], ['versions'])).toThrow(
      /Unknown argument/,
    );
  });
});
