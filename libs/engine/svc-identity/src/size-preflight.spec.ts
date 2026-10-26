// M1-23 slice D: the size preflight (AC-18 to AC-20). The sizes are exact byte counts, so each
// boundary is tested on both sides.
import { describe, expect, it } from 'vitest';

import { SecretValue } from './internal/secret-value';
import type { IssuedCredential } from './provider';
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
} from './size-preflight';

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
});
