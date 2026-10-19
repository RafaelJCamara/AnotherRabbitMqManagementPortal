import { describe, expect, it } from 'vitest';
import { semanticsRegistry, UNKNOWN_EXCHANGE_TYPE } from '../index.ts';
import { v } from '../testing/profile.ts';
import { tapRules } from './tap-rules.data.ts';

const VERSIONS = [
  '3.13.7',
  '4.0.9',
  '4.2.9',
  '4.3.0',
  '4.3.5',
  '4.3.6',
  '4.4.0',
];

describe('tap rules (fact sheet c.1, DC-18)', () => {
  it('lists exactly the exchange types it describes', () => {
    expect(tapRules.map((rule) => rule.exchangeType).sort()).toEqual([
      'direct',
      'fanout',
      'headers',
      'topic',
      'x-consistent-hash',
      'x-local-random',
      'x-modulus-hash',
      'x-random',
      'x-recent-history',
    ]);
  });

  it('a consistent-hash tap diverts, is refused by default and gets no e2e below 4.3.6', () => {
    for (const version of ['3.13.7', '4.2.9', '4.3.0', '4.3.4', '4.3.5']) {
      expect(
        semanticsRegistry.tapRule('x-consistent-hash', v(version)),
        version,
      ).toEqual({ diverts: true, e2eAllowed: false, refuseByDefault: true });
    }
  });

  it('a consistent-hash tap may use e2e from 4.3.6, but still diverts and is still refused by default', () => {
    for (const version of ['4.3.6', '4.3.7', '4.4.0']) {
      expect(
        semanticsRegistry.tapRule('x-consistent-hash', v(version)),
        version,
      ).toEqual({ diverts: true, e2eAllowed: true, refuseByDefault: true });
    }
  });

  it('an unreadable version gets the worst case for consistent-hash', () => {
    expect(semanticsRegistry.tapRule('x-consistent-hash', null)).toEqual({
      diverts: true,
      e2eAllowed: false,
      refuseByDefault: true,
    });
  });

  it('hash, random and local-random types divert and are refused on every version; e2e is never allowed for them', () => {
    for (const type of ['x-modulus-hash', 'x-random', 'x-local-random']) {
      for (const version of VERSIONS) {
        expect(
          semanticsRegistry.tapRule(type, v(version)),
          `${type} ${version}`,
        ).toEqual({
          diverts: true,
          e2eAllowed: false,
          refuseByDefault: true,
        });
      }
      expect(semanticsRegistry.tapRule(type, null)).toEqual({
        diverts: true,
        e2eAllowed: false,
        refuseByDefault: true,
      });
    }
  });

  it('types that copy to every destination do not divert, need no consent and allow e2e', () => {
    for (const type of ['direct', 'topic', 'fanout', 'headers']) {
      for (const version of [...VERSIONS.map(v), null]) {
        expect(semanticsRegistry.tapRule(type, version), type).toEqual({
          diverts: false,
          e2eAllowed: true,
          refuseByDefault: false,
        });
      }
    }
  });

  it('a recent-history tap takes nothing, but gets no e2e because its cache replay would reach the destination', () => {
    expect(semanticsRegistry.tapRule('x-recent-history', v('4.3.6'))).toEqual({
      diverts: false,
      e2eAllowed: false,
      refuseByDefault: false,
    });
  });

  it('a plugin type nobody described is refused, assumed to divert and denied e2e', () => {
    for (const type of [
      'x-delayed-message',
      'x-jms-topic',
      'X-RANDOM',
      '',
      'topic ',
    ]) {
      expect(semanticsRegistry.tapRule(type, v('4.3.6')), type).toEqual(
        UNKNOWN_EXCHANGE_TYPE,
      );
    }
    expect(UNKNOWN_EXCHANGE_TYPE).toEqual({
      diverts: true,
      e2eAllowed: false,
      refuseByDefault: true,
    });
  });
});
