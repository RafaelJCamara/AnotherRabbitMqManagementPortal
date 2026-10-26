// M1-23 slice D: the size preflight (AC-18 to AC-21). The sizes are exact byte counts, so each
// boundary is tested on both sides; the texts are keys into `i18n/en/warnings.json`.
import { createManualClock, createManualTimers } from '@app/kernel';
import type { ConnectionAuthPort } from '@app/ports';
import { describe, expect, it } from 'vitest';

import texts from '../i18n/en/warnings.json' with { type: 'json' };

import { SecretValue } from './internal/secret-value';
import type { CredentialProvider, IssuedCredential } from './provider';
import {
  BEARER_HEADER_WARN_BYTES,
  PREAUTH_FRAME_LIMIT_BYTES,
  PREAUTH_FRAME_LIMIT_LEGACY_BYTES,
  PREAUTH_HEADROOM_BYTES,
  httpAuthorization,
  preflightCredential,
  preflightSize,
  type PreflightInput,
  type SizeWarning,
  type SizeWarningCode,
} from './size-preflight';
import {
  createTokenManager,
  type IdentityCapabilities,
  type SizeWarningEvent,
} from './token-manager';

const signal = new AbortController().signal;
const NEW_FRAME = { amqp091PreAuthFrame8192: true } as const;
const OLD_FRAME = { amqp091PreAuthFrame8192: false } as const;

const input = (over: Partial<PreflightInput>): PreflightInput => ({
  token: 't',
  username: 'alice',
  protocol: 'http',
  asBasic: false,
  caps: OLD_FRAME,
  ...over,
});

/** A token that makes a `Bearer <token>` header of exactly `headerBytes` bytes. */
const tokenForHeader = (headerBytes: number): string =>
  'a'.repeat(headerBytes - 'Bearer '.length);

describe('size preflight (M1-23, DC-38)', () => {
  it('M1-23 AC-18 size preflight warns above 4,000 bytes of Bearer header and measures Basic by its encoded size', () => {
    expect(BEARER_HEADER_WARN_BYTES).toBe(4000);
    expect(
      preflightSize(input({ token: tokenForHeader(3999) })),
      '3,999',
    ).toEqual([]);
    expect(
      preflightSize(input({ token: tokenForHeader(4000) })),
      '4,000',
    ).toEqual([]);
    const over = preflightSize(input({ token: tokenForHeader(4001) }));
    expect(over).toEqual([
      {
        code: 'BEARER_HEADER_LARGE',
        textKey: 'identity.BEARER_HEADER_LARGE.v1',
        bytes: 4001,
        limit: 4000,
      },
    ]);

    // The same token as Basic: `Basic ` plus the base64 of `user:token`, so it warns sooner.
    // 2,900 token bytes and a 5-byte user: 5 + 1 + 2,900 = 2,906 bytes, 3,876 as base64, 3,882 in all.
    const basicToken = 'a'.repeat(2900);
    expect(
      preflightSize(input({ token: basicToken, asBasic: false })),
      'as Bearer it is small',
    ).toEqual([]);
    const basic = (token: string): readonly SizeWarning[] =>
      preflightSize(input({ token, asBasic: true }));
    expect(basic(basicToken)).toEqual([]);
    expect(
      preflightSize(input({ token: 'a'.repeat(2994), asBasic: false })),
      'the same token as Bearer is 3,001 bytes',
    ).toEqual([]);
    // 2,994 token bytes: 5 + 1 + 2,994 = 3,000 bytes = 4,000 as base64, 4,006 with the scheme.
    expect(basic('a'.repeat(2994))).toEqual([
      {
        code: 'BEARER_HEADER_LARGE',
        textKey: 'identity.BEARER_HEADER_LARGE.v1',
        bytes: 4006,
        limit: 4000,
      },
    ]);
    // 2,991 token bytes: 2,997 bytes = 3,996 as base64, 4,002 with the scheme: still over.
    expect(basic('a'.repeat(2991))[0]?.bytes).toBe(4002);
    // 2,988: 2,994 bytes = 3,992 as base64, 3,998 with the scheme: under.
    expect(basic('a'.repeat(2988))).toEqual([]);
    // The size is the real one, for every padding case: it equals the header a client would send.
    for (let tokenBytes = 2980; tokenBytes <= 3010; tokenBytes += 1) {
      const token = 'a'.repeat(tokenBytes);
      const sent = `Basic ${Buffer.from(`alice:${token}`).toString('base64')}`;
      const found = basic(token);
      if (sent.length > 4000)
        expect(found[0]?.bytes, String(tokenBytes)).toBe(sent.length);
      else expect(found, String(tokenBytes)).toEqual([]);
    }
    // The size is the real one: it equals the header a client would send.
    const real = `Basic ${Buffer.from(`alice:${'a'.repeat(2994)}`).toString('base64')}`;
    expect(real.length).toBe(4006);
  });

  it('M1-23 AC-19 size preflight uses the pre-auth frame limit of the broker era and the smaller one when unknown', () => {
    expect(PREAUTH_FRAME_LIMIT_BYTES).toBe(8192);
    expect(PREAUTH_FRAME_LIMIT_LEGACY_BYTES).toBe(4096);
    expect(PREAUTH_HEADROOM_BYTES).toBe(1024);
    // The response is 0x00 user 0x00 token: 1 + 5 + 1 + token bytes.
    const plain = (
      tokenBytes: number,
      caps: PreflightInput['caps'],
      protocol: PreflightInput['protocol'] = 'amqp091',
    ): readonly SizeWarning[] =>
      preflightSize(input({ token: 'a'.repeat(tokenBytes), protocol, caps }));
    // Limit 8,192: the response may be 8,192 - 1,024 = 7,168 bytes, so a 7,161-byte token fits.
    expect(plain(7161, NEW_FRAME), '7,168 response').toEqual([]);
    expect(plain(7162, NEW_FRAME)).toEqual([
      {
        code: 'PLAIN_RESPONSE_LARGE',
        textKey: 'identity.PLAIN_RESPONSE_LARGE.v1',
        bytes: 7169,
        limit: 8192,
      },
    ]);
    // Limit 4,096: the response may be 3,072 bytes, so a 3,065-byte token fits.
    expect(plain(3065, OLD_FRAME), '3,072 response').toEqual([]);
    expect(plain(3066, OLD_FRAME)).toEqual([
      {
        code: 'PLAIN_RESPONSE_LARGE',
        textKey: 'identity.PLAIN_RESPONSE_LARGE.v1',
        bytes: 3073,
        limit: 4096,
      },
    ]);
    // A token between the two boundaries warns under the old limit only.
    expect(plain(5000, OLD_FRAME)).toHaveLength(1);
    expect(plain(5000, NEW_FRAME)).toEqual([]);
    // Unknown means the capability did not hold: the smaller limit. AMQP 1.0 and streams have no
    // rule, so they take the smaller limit even when the AMQP 0-9-1 rule holds.
    expect(plain(5000, NEW_FRAME, 'amqp10')).toHaveLength(1);
    expect(plain(5000, NEW_FRAME, 'stream')).toHaveLength(1);
    // The user name counts, in bytes: three 2-byte characters are 6 bytes.
    expect(
      preflightSize(
        input({
          token: 'a'.repeat(3064),
          username: 'ééé',
          protocol: 'amqp091',
        }),
      ),
      '1 + 6 + 1 + 3,064 = 3,072',
    ).toEqual([]);
    expect(
      preflightSize(
        input({
          token: 'a'.repeat(3065),
          username: 'ééé',
          protocol: 'amqp091',
        }),
      )[0]?.bytes,
    ).toBe(3073);
    // A header is not measured against a frame, and a frame is not measured against a header.
    expect(
      preflightSize(
        input({ token: 'a'.repeat(3500), protocol: 'http', caps: OLD_FRAME }),
      ),
    ).toEqual([]);
    expect(
      preflightSize(
        input({
          token: 'a'.repeat(3500),
          protocol: 'amqp091',
          caps: OLD_FRAME,
        }),
      ),
    ).toHaveLength(1);
  });

  it('M1-23 AC-20 Bearer is always preferred over Basic for a token', () => {
    const bearer: IssuedCredential = {
      kind: 'bearer',
      token: new SecretValue('tok-en'),
      issuedAt: 0,
      expiresAt: 1000,
      username: 'alice',
    };
    const password: IssuedCredential = {
      kind: 'password',
      username: 'alice',
      password: new SecretValue('s3cret'),
    };
    expect(httpAuthorization(bearer)).toBe('Bearer tok-en');
    expect(httpAuthorization(password)).toBe(
      `Basic ${Buffer.from('alice:s3cret').toString('base64')}`,
    );
    expect(httpAuthorization({ kind: 'external' })).toBeUndefined();
    // A token is measured as the Bearer header it is sent as, never as Basic.
    const big: IssuedCredential = {
      ...bearer,
      token: new SecretValue(tokenForHeader(4001)),
    };
    expect(httpAuthorization(big)).toBe(`Bearer ${tokenForHeader(4001)}`);
    expect(preflightCredential(big, 'http', OLD_FRAME)[0]?.bytes).toBe(4001);
    // Only a token has a size to warn about.
    expect(preflightCredential(password, 'http', OLD_FRAME)).toEqual([]);
    expect(
      preflightCredential({ kind: 'external' }, 'amqp091', OLD_FRAME),
    ).toEqual([]);
    // A token without a user name is measured with an empty one: 1 + 0 + 1 + token.
    const anonymous: IssuedCredential = {
      ...bearer,
      token: new SecretValue('a'.repeat(3070)),
      username: null,
    };
    expect(preflightCredential(anonymous, 'amqp091', OLD_FRAME)).toEqual([]);
    expect(
      preflightCredential(
        { ...anonymous, token: new SecretValue('a'.repeat(3071)) },
        'amqp091',
        OLD_FRAME,
      )[0]?.bytes,
    ).toBe(3073);
  });

  it('M1-23 AC-21 size warnings precede the first use and are keys, not prose', async () => {
    const clock = createManualClock(0);
    const timers = createManualTimers(clock);
    const big = 'a'.repeat(9000); // above every limit, for HTTP and for AMQP
    const credential: IssuedCredential = {
      kind: 'bearer',
      token: new SecretValue(big),
      issuedAt: 0,
      expiresAt: 1_000_000,
      username: 'alice',
    };
    const provider: CredentialProvider = {
      kind: 'client-credentials',
      acquire: () => Promise.resolve(credential),
    };
    const auth: ConnectionAuthPort = {
      updateSecret: () => Promise.resolve(),
      reconnect: () => Promise.resolve(),
      cancelOwnConsumers: () => Promise.resolve({ cancelled: 0 }),
      onCredentialExpiredClose: () => () => undefined,
    };
    const caps: IdentityCapabilities = {
      amqp10TokenRenewalEndpoint: true,
      amqp091ClosesAtCredentialExpiry: true,
      amqp091PreAuthFrame8192: true,
    };
    const heard: SizeWarningEvent[] = [];
    let returned = false;
    let heardBeforeReturn = 0;
    const manager = createTokenManager({
      providers: { providerFor: () => Promise.resolve(provider) },
      auth,
      capabilities: () => caps,
      onSizeWarning: (event) => {
        if (!returned) heardBeforeReturn += 1;
        heard.push(event);
      },
      clock,
      timers,
    });

    const http = manager.credentialFor('c1', 'http', signal).then((value) => {
      returned = true;
      return value;
    });
    const resolvedHttp = await http;
    // The sink heard the warning before the promise resolved, and the credential is still usable.
    expect(heardBeforeReturn).toBe(1);
    expect(resolvedHttp.credential.kind).toBe('bearer');
    expect(resolvedHttp.warnings).toEqual([
      {
        code: 'BEARER_HEADER_LARGE',
        textKey: 'identity.BEARER_HEADER_LARGE.v1',
        bytes: 'Bearer '.length + 9000,
        limit: 4000,
      },
    ]);
    returned = false;
    const resolvedAmqp = await manager.credentialFor('c1', 'amqp', signal);
    expect(heardBeforeReturn).toBe(2);
    expect(resolvedAmqp.warnings.map((w) => w.code)).toEqual([
      'PLAIN_RESPONSE_LARGE',
    ]);
    expect(resolvedAmqp.warnings[0]).toMatchObject({
      bytes: 1 + 5 + 1 + 9000,
      limit: 8192,
    });
    expect(heard.map((event) => [event.protocol, event.warning.code])).toEqual([
      ['http', 'BEARER_HEADER_LARGE'],
      ['amqp', 'PLAIN_RESPONSE_LARGE'],
    ]);
    expect(manager.stats().sizeWarnings).toBe(2);

    // The texts are keys of the English file; they say "may", never that the request will fail,
    // and none claims what the honest-wording rule forbids.
    const lookup = (key: string): string => {
      let node: unknown = texts;
      for (const part of key.split('.')) {
        node = (node as Record<string, unknown>)[part];
      }
      return node as string;
    };
    const codes: SizeWarningCode[] = [
      'BEARER_HEADER_LARGE',
      'PLAIN_RESPONSE_LARGE',
    ];
    expect(Object.keys(texts.identity).sort()).toEqual([...codes].sort());
    for (const warning of [
      ...resolvedHttp.warnings,
      ...resolvedAmqp.warnings,
    ]) {
      const text = lookup(warning.textKey);
      expect(typeof text, warning.textKey).toBe('string');
      expect(text).toMatch(/\bmay\b/);
      expect(text).toContain('{{bytes}}');
      expect(text).toContain('{{limit}}');
      expect(text).not.toMatch(/\bwill (fail|be refused|not)\b/i);
      expect(text).not.toMatch(/read-only|non-?destructive/i);
      // The warning itself is numbers and a key: no prose, no token.
      expect(JSON.stringify(warning)).not.toContain('aaaa');
    }
  });
});

/** A manager whose provider hands out `next(n)` (1-based) and whose sink records what it hears. */
function warningRig(
  next: (n: number, now: number) => IssuedCredential,
  sink?: (event: SizeWarningEvent) => void,
) {
  const clock = createManualClock(0);
  const heard: SizeWarningEvent[] = [];
  let n = 0;
  const manager = createTokenManager({
    providers: {
      providerFor: () =>
        Promise.resolve({
          kind: 'client-credentials',
          acquire: () => {
            n += 1;
            return Promise.resolve(next(n, clock.now()));
          },
        } satisfies CredentialProvider),
    },
    auth: {
      updateSecret: () => Promise.resolve(),
      reconnect: () => Promise.resolve(),
      cancelOwnConsumers: () => Promise.resolve({ cancelled: 0 }),
      onCredentialExpiredClose: () => () => undefined,
    },
    capabilities: () => ({
      amqp10TokenRenewalEndpoint: true,
      amqp091ClosesAtCredentialExpiry: true,
      amqp091PreAuthFrame8192: true,
    }),
    onSizeWarning: (event) => {
      heard.push(event);
      sink?.(event);
    },
    clock,
    timers: createManualTimers(clock),
  });
  return { manager, heard, clock };
}

const bearerOf = (token: string, expiresAt = 1_000_000): IssuedCredential => ({
  kind: 'bearer',
  token: new SecretValue(token),
  issuedAt: 0,
  expiresAt,
  username: 'alice',
});

describe('size warnings in the TokenManager (M1-23, slice D)', () => {
  it('M1-23 slice D a warning is heard once per generation and again after a renewal, and a 401 renewal carries its own warnings', async () => {
    const big = 'a'.repeat(4100);
    const { manager, heard, clock } = warningRig((n) =>
      bearerOf(big, 1_000_000 + n),
    );
    const first = await manager.credentialFor('c1', 'http', signal);
    const again = await manager.credentialFor('c1', 'http', signal);
    // Every value carries the warnings; the sink hears them once for the generation.
    expect(first.warnings).toHaveLength(1);
    expect(again.warnings).toEqual(first.warnings);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      connectionId: 'c1',
      protocol: 'http',
      generation: first.generation,
    });
    expect(manager.stats().sizeWarnings).toBe(1);

    clock.setNow(clock.now() + 6_000); // past the 5 s floor between renewals
    const renewed = await manager.refreshAfterUnauthorized(
      'c1',
      'http',
      first.generation,
      signal,
    );
    expect(renewed.generation).toBeGreaterThan(first.generation);
    expect(renewed.warnings).toHaveLength(1);
    expect(heard).toHaveLength(2);
    expect(heard[1]?.generation).toBe(renewed.generation);
    expect(manager.stats().sizeWarnings).toBe(2);

    // Another protocol of the same connection is another entry, measured for its own carrier: the
    // same 4,100 bytes fit the 8,192-byte frame (with the headroom), so there is nothing to hear.
    const amqp = await manager.credentialFor('c1', 'amqp', signal);
    expect(amqp.warnings).toEqual([]);
    expect(heard).toHaveLength(2);
  });

  it('M1-23 slice D a sink that throws neither blocks the credential nor hides the failure', async () => {
    const { manager } = warningRig(
      () => bearerOf('a'.repeat(4100)),
      () => {
        throw new Error('sink down');
      },
    );
    const resolved = await manager.credentialFor('c1', 'http', signal);
    expect(resolved.credential.kind).toBe('bearer');
    expect(resolved.warnings).toHaveLength(1);
    expect(manager.stats()).toMatchObject({
      sizeWarnings: 1,
      listenerErrors: 1,
    });
  });

  it('M1-23 slice D a token that fits, a password and a certificate login give no warning', async () => {
    const small = warningRig(() => bearerOf('a'.repeat(100)));
    expect(
      (await small.manager.credentialFor('c1', 'http', signal)).warnings,
    ).toEqual([]);
    expect(
      (await small.manager.credentialFor('c1', 'amqp', signal)).warnings,
    ).toEqual([]);
    const password = warningRig(() => ({
      kind: 'password',
      username: 'alice',
      password: new SecretValue('p'.repeat(9000)),
    }));
    expect(
      (await password.manager.credentialFor('c1', 'amqp', signal)).warnings,
    ).toEqual([]);
    const external = warningRig(() => ({ kind: 'external' }));
    expect(
      (await external.manager.credentialFor('c1', 'amqp', signal)).warnings,
    ).toEqual([]);
    for (const rig of [small, password, external]) {
      expect(rig.heard).toEqual([]);
      expect(rig.manager.stats().sizeWarnings).toBe(0);
    }
  });
});
