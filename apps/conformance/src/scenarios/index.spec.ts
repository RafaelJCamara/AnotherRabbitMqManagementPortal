import { describe, expect, it } from 'vitest';

import { declareQueue, defineScenario, publish } from '../dsl.ts';
import { cfSmoke01 } from './cf-smoke-01.ts';
import { SCENARIOS, selectScenarios } from './index.ts';

const make = (cfId: string) =>
  defineScenario({
    cfId,
    title: cfId,
    protocol: 'amqp091',
    steps: [declareQueue('q'), publish('q', 'm1')],
  });
const pool = [
  make('CF-SETTLE-01'),
  make('CF-SETTLE-02'),
  make('CF-CARRY-01'),
  make('CF-SETTLED-01'),
];
const ids = (list: readonly { cfId: string }[]) =>
  list.map((entry) => entry.cfId);

describe('the scenarios conformance:record can run', () => {
  it('CF-SMOKE-01 is registered, once', () => {
    expect(ids(SCENARIOS)).toEqual(['CF-SMOKE-01']);
    expect(selectScenarios(['CF-SMOKE-01'])).toEqual([cfSmoke01]);
  });

  it('selects by exact id and by a pattern with *, without duplicates, in the order of the pool', () => {
    expect(ids(selectScenarios(['CF-CARRY-01'], pool))).toEqual([
      'CF-CARRY-01',
    ]);
    expect(ids(selectScenarios(['CF-SETTLE-*'], pool))).toEqual([
      'CF-SETTLE-01',
      'CF-SETTLE-02',
    ]);
    expect(
      ids(selectScenarios(['CF-SETTLE-01', 'CF-SETTLE-*', 'CF-CARRY-*'], pool)),
    ).toEqual(['CF-SETTLE-01', 'CF-SETTLE-02', 'CF-CARRY-01']);
  });

  it('an exact id does not match a longer one', () => {
    expect(ids(selectScenarios(['CF-SETTLE-01'], pool))).toEqual([
      'CF-SETTLE-01',
    ]);
    expect(() => selectScenarios(['CF-SETTLE'], pool)).toThrow(
      /no scenario matches/,
    );
  });

  it('a cell with no scenario is an error, not a skipped cell', () => {
    expect(() => selectScenarios(['CF-NOPE-01'], pool)).toThrow(
      /no scenario matches CF-NOPE-01; known: CF-SETTLE-01/,
    );
    expect(() => selectScenarios(['CF-SETTLE-01', 'CF-NOPE-*'], pool)).toThrow(
      /no scenario matches CF-NOPE-\*/,
    );
  });

  it.each([
    '',
    'settle',
    'cf-settle-01',
    'CF-SETTLE-0.',
    'CF-(SETTLE)',
    '*',
    'CF-SETTLE-01;rm',
  ])(
    'refuses the pattern %j (and cannot be used as a regular expression)',
    (pattern) => {
      expect(() => selectScenarios([pattern], pool)).toThrow(
        /not a conformance id/,
      );
    },
  );

  it('refuses an empty list', () => {
    expect(() => selectScenarios([], pool)).toThrow(/names no cell/);
  });
});
