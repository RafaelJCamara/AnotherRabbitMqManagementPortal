import { describe, expect, it } from 'vitest';

import { alternateExchangeFor, alternateExchangeOf } from './ae.ts';
import { routingKeysOf } from './cc-bcc.ts';
import { DEFAULT_EXCHANGE, routeDefault } from './default-exchange.ts';
import { directRule } from './direct.ts';
import { fanoutRule } from './fanout.ts';

describe('routing keys with CC and BCC', () => {
  it('M1-02 AC-5 lists the routing key, then CC, then BCC, with the source of each', () => {
    const out = routingKeysOf('rk', { CC: ['c1', 'c2'], BCC: ['b1'] });
    expect(out).toEqual({
      ok: true,
      keys: [
        { key: 'rk', source: 'routing-key' },
        { key: 'c1', source: 'cc' },
        { key: 'c2', source: 'cc' },
        { key: 'b1', source: 'bcc' },
      ],
      parts: { routingKey: 'rk', cc: ['c1', 'c2'], bcc: ['b1'] },
    });
  });

  it('M1-02 AC-5 skips elements that are not strings and takes none from an absent header', () => {
    const out = routingKeysOf('rk', { CC: ['c1', 5, null, ['x'], true] });
    expect(out).toMatchObject({
      ok: true,
      parts: { cc: ['c1'], bcc: [] },
    });
    expect(routingKeysOf('rk', undefined)).toMatchObject({
      ok: true,
      keys: [{ key: 'rk', source: 'routing-key' }],
    });
  });

  it('M1-02 AC-5 refuses a CC or BCC header that is not an array (CC is checked first)', () => {
    expect(routingKeysOf('rk', { CC: 'q1' })).toEqual({
      ok: false,
      header: 'CC',
    });
    expect(routingKeysOf('rk', { BCC: 7 })).toEqual({
      ok: false,
      header: 'BCC',
    });
    expect(routingKeysOf('rk', { CC: null })).toEqual({
      ok: false,
      header: 'CC',
    });
    expect(routingKeysOf('rk', { BCC: { a: 1 }, CC: 'x' })).toEqual({
      ok: false,
      header: 'CC',
    });
  });

  it('M1-02 AC-5 reads CC and BCC only as own properties', () => {
    const inherited = Object.create({ CC: ['evil'] }) as Record<string, never>;
    expect(routingKeysOf('rk', inherited)).toMatchObject({
      ok: true,
      parts: { cc: [] },
    });
  });
});

describe('direct, fanout, default exchange, alternate exchange', () => {
  const keys = [
    { key: 'k1', source: 'routing-key' as const },
    { key: 'k2', source: 'bcc' as const },
  ];

  it('M1-02 AC-3 a direct binding matches an equal key, whichever key of the message, exactly', () => {
    expect(directRule({ routingKey: 'k2' }, keys)).toEqual({
      kind: 'direct',
      routingKey: 'k2',
      keySource: 'bcc',
    });
    expect(directRule({ routingKey: 'K1' }, keys)).toBeNull();
    expect(directRule({ routingKey: 'k' }, keys)).toBeNull();
    expect(
      directRule({ routingKey: '' }, [{ key: '', source: 'routing-key' }]),
    ).not.toBeNull();
    expect(directRule({ routingKey: 'k1' }, [])).toBeNull();
  });

  it('M1-02 AC-3 a fanout binding always matches', () => {
    expect(fanoutRule()).toEqual({ kind: 'fanout' });
  });

  it('M1-02 AC-4 the default exchange maps each key that names a queue to that queue once', () => {
    const queues = new Set(['q1', 'q2']);
    expect(DEFAULT_EXCHANGE).toBe('');
    expect(
      routeDefault(
        [
          { key: 'q1', source: 'routing-key' },
          { key: 'nope', source: 'cc' },
          { key: 'q2', source: 'cc' },
          { key: 'q1', source: 'bcc' },
        ],
        queues,
      ),
    ).toEqual([
      { queue: 'q1', key: 'q1', source: 'routing-key' },
      { queue: 'q2', key: 'q2', source: 'cc' },
    ]);
    expect(
      routeDefault([{ key: 'Q1', source: 'routing-key' }], queues),
    ).toEqual([]);
  });

  it('M1-02 AC-7 the AE applies only to an exchange with no destination of its own', () => {
    expect(alternateExchangeOf({ alternateExchange: 'ae' })).toBe('ae');
    expect(alternateExchangeOf({ alternateExchange: null })).toBeNull();
    expect(alternateExchangeOf({})).toBeNull();
    expect(alternateExchangeOf({ alternateExchange: '' })).toBeNull();
    expect(alternateExchangeFor(0, { alternateExchange: 'ae' })).toBe('ae');
    expect(alternateExchangeFor(1, { alternateExchange: 'ae' })).toBeNull();
    expect(alternateExchangeFor(0, {})).toBeNull();
  });
});
