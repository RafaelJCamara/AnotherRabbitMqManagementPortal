import { describe, expect, it } from 'vitest';

import { NetworkError } from '@app/net-truststore';

import {
  allowAllPolicy,
  approvedLookup,
  evaluatePolicy,
  resolveHost,
  systemResolver,
  type EgressRequest,
  type Resolver,
} from './policy-hook.ts';

const request: EgressRequest = {
  host: 'a.test',
  port: 5672,
  purpose: 'test',
  addresses: ['10.0.0.1'],
};

describe('evaluatePolicy', () => {
  it('allows only an explicit allowed:true', async () => {
    expect(await evaluatePolicy(allowAllPolicy, request)).toEqual({
      allowed: true,
    });
  });

  it.each([
    ['allowed:"yes"', { allowed: 'yes' }],
    ['allowed:1', { allowed: 1 }],
    ['an empty object', {}],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'allowed'],
  ])('denies %s', async (_label, answer) => {
    const decision = await evaluatePolicy(
      { evaluate: () => answer as never },
      request,
    );

    expect(decision.allowed).toBe(false);
  });

  it('keeps the reason a policy gives and supplies one when it gives none', async () => {
    const withReason = await evaluatePolicy(
      { evaluate: () => ({ allowed: false, reason: 'RFC 1918' }) },
      request,
    );
    const without = await evaluatePolicy(
      { evaluate: () => ({ allowed: false, reason: '' }) },
      request,
    );

    expect(withReason).toEqual({ allowed: false, reason: 'RFC 1918' });
    expect(without).toEqual({
      allowed: false,
      reason: 'denied by the egress policy',
    });
  });
});

describe('resolveHost', () => {
  it('treats an IP literal as its own resolution and never calls the resolver', async () => {
    const resolver: Resolver = () => {
      throw new Error('must not be called');
    };

    expect(await resolveHost('10.1.2.3', resolver)).toEqual([
      { address: '10.1.2.3', family: 4 },
    ]);
    expect(await resolveHost('::1', resolver)).toEqual([
      { address: '::1', family: 6 },
    ]);
  });

  it('asks the resolver for a name', async () => {
    const resolver: Resolver = (host) =>
      Promise.resolve([{ address: `1.1.1.${String(host.length)}`, family: 4 }]);

    expect(await resolveHost('abc.test', resolver)).toEqual([
      { address: '1.1.1.8', family: 4 },
    ]);
  });

  it('the system resolver returns every address of localhost', async () => {
    const addresses = await systemResolver('localhost');

    expect(addresses.length).toBeGreaterThan(0);
    expect(
      addresses.some(
        (entry) => entry.address === '127.0.0.1' || entry.address === '::1',
      ),
    ).toBe(true);
  });
});

describe('approvedLookup', () => {
  const approved = [
    { address: '10.0.0.1', family: 4 as const },
    { address: 'fd00::1', family: 6 as const },
  ];
  const lookup = approvedLookup('broker.test', approved);

  function call(
    hostname: string,
    options: Parameters<typeof lookup>[1],
  ): { error: Error | null; result: unknown; family?: number | undefined } {
    let outcome: ReturnType<typeof call> | undefined;
    lookup(hostname, options, (error, address, family) => {
      outcome = { error, result: address, family };
    });
    if (outcome === undefined) throw new Error('the lookup did not answer');
    return outcome;
  }

  it('serves every approved address when asked for all', () => {
    const { error, result } = call('broker.test', { all: true });

    expect(error).toBeNull();
    expect(result).toEqual([
      { address: '10.0.0.1', family: 4 },
      { address: 'fd00::1', family: 6 },
    ]);
  });

  it('serves the first approved address when asked for one', () => {
    const { result, family } = call('broker.test', {});

    expect(result).toBe('10.0.0.1');
    expect(family).toBe(4);
  });

  it('honours a requested family but never invents an address', () => {
    expect(call('broker.test', { family: 6 }).result).toBe('fd00::1');
    const none = approvedLookup('broker.test', approved.slice(0, 1));
    let error: Error | null = null;
    none('broker.test', { family: 6 }, (failure) => {
      error = failure;
    });
    expect(error).toBeInstanceOf(NetworkError);
  });

  it('refuses to resolve any other name: no fallback to DNS', () => {
    const { error } = call('evil.test', { all: true });

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).code).toBe('EGRESS_DENIED');
  });
});
