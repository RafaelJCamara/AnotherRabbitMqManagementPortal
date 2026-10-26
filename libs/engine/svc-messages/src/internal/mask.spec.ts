// M1-19 slice C: the mask of a publish for its history. The AC tests (AC-11, AC-16) are in
// publish-history.spec.ts; these are the rules under them, each against the mutant that would drop
// it: a key list that is too short, a text rule that is skipped, a JSON body that is rewritten when
// nothing was masked, a long run that reaches the expressions, a mask that is not idempotent.
import { createCanaryScanner, REDACTED } from '@app/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  LONG_RUN_MARKER,
  MASK_MAX_BODY_BYTES,
  maskBody,
  maskBodyText,
  maskMessage,
  maskString,
  remaskMessage,
  type WireHeader,
} from './mask';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const str = (v: string): WireHeader => ({ t: 'string', v });

const SECRET = 'S3cr3t-Canary-Vq8LmZ4x';
const leaks = (value: unknown): boolean =>
  createCanaryScanner([SECRET]).scan(JSON.stringify(value)).length > 0;

describe('M1-19 mask: headers', () => {
  it('M1-19 mask: a header whose name says a secret loses its value, whatever its type or case', () => {
    const out = maskMessage({
      props: {},
      body: text(''),
      headers: {
        Authorization: str(`Bearer ${SECRET}`),
        COOKIE: str(SECRET),
        'x-api-key': str(SECRET),
        'X-Auth-Token': {
          t: 'bytes',
          v: Buffer.from(SECRET).toString('base64'),
        },
        'x-session-id': { t: 'long', v: 123456 },
        client_secret: str(SECRET),
        'x-trace': str('t-1'),
        'x-count': { t: 'long', v: 5 },
      },
    });
    expect(out.headers?.Authorization).toEqual(str(REDACTED));
    expect(out.headers?.COOKIE).toEqual(str(REDACTED));
    expect(out.headers?.['x-api-key']).toEqual(str(REDACTED));
    expect(out.headers?.['X-Auth-Token']).toEqual(str(REDACTED));
    expect(out.headers?.['x-session-id']).toEqual(str(REDACTED));
    expect(out.headers?.client_secret).toEqual(str(REDACTED));
    // What is not a secret is left as typed.
    expect(out.headers?.['x-trace']).toEqual(str('t-1'));
    expect(out.headers?.['x-count']).toEqual({ t: 'long', v: 5 });
    expect(out.masked).toEqual([
      'header:Authorization',
      'header:COOKIE',
      'header:x-api-key',
      'header:X-Auth-Token',
      'header:x-session-id',
      'header:client_secret',
    ]);
    expect(leaks(out)).toBe(false);
  });

  it('M1-19 mask: a secret nested in a table or a list is masked and the header is named at the top', () => {
    const out = maskMessage({
      props: {},
      body: text(''),
      headers: {
        'x-meta': {
          t: 'table',
          v: [
            { name: 'password', value: str(SECRET) },
            { name: 'url', value: str(`amqp://guest:${SECRET}@host/vhost`) },
            { name: 'note', value: str('plain') },
            {
              name: 'inner',
              value: {
                t: 'array',
                v: [{ value: str(`Bearer ${SECRET}Zz`) }, { value: str('ok') }],
              },
            },
          ],
        },
        'x-clean': {
          t: 'table',
          v: [{ name: 'a', value: { t: 'array', v: [{ value: str('b') }] } }],
        },
      },
    });
    expect(out.masked).toEqual(['header:x-meta']);
    expect(leaks(out)).toBe(false);
    const meta = out.headers?.['x-meta']?.v as {
      name?: string;
      value: WireHeader;
    }[];
    expect(meta[0]).toEqual({ name: 'password', value: str(REDACTED) });
    expect(meta[2]).toEqual({ name: 'note', value: str('plain') });
    // A list entry keeps having no name.
    const list = meta[3]?.value.v as { name?: string; value: WireHeader }[];
    expect(list[1]).toEqual({ value: str('ok') });
    expect('name' in (list[0] ?? {})).toBe(false);
    // A table with nothing to mask comes back equal, and is not reported.
    expect(out.headers?.['x-clean']).toEqual({
      t: 'table',
      v: [{ name: 'a', value: { t: 'array', v: [{ value: str('b') }] } }],
    });
  });

  it('M1-19 mask: bytes that read as a secret are not shown, other bytes are kept', () => {
    const secret = Buffer.from(`password=${SECRET}`).toString('base64');
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString('base64');
    const out = maskMessage({
      props: {},
      body: text(''),
      headers: {
        'x-blob': { t: 'bytes', v: secret },
        'x-bin': { t: 'bytes', v: binary },
      },
    });
    expect(out.headers?.['x-blob']).toEqual(str(REDACTED));
    expect(out.headers?.['x-bin']).toEqual({ t: 'bytes', v: binary });
    expect(out.masked).toEqual(['header:x-blob']);
  });

  it('M1-19 mask: a header called __proto__ stays an own key and the table has no prototype', () => {
    const headers = JSON.parse(
      `{"__proto__": {"t":"string","v":"x"}, "a": {"t":"string","v":"b"}}`,
    ) as Record<string, WireHeader>;
    const out = maskMessage({ props: {}, body: text(''), headers });
    expect(Object.getPrototypeOf(out.headers)).toBeNull();
    expect(Object.keys(out.headers ?? {})).toEqual(['__proto__', 'a']);
  });

  it('M1-19 mask: a header that is not shaped like one is not shown at all', () => {
    const headers = { odd: 'plain' as unknown as WireHeader };
    const out = maskMessage({ props: {}, body: text(''), headers });
    expect(out.headers?.odd).toEqual(str(REDACTED));
    expect(out.masked).toEqual(['header:odd']);
  });
});

describe('M1-19 mask: properties', () => {
  it('M1-19 mask: a property is masked by its text and left alone otherwise', () => {
    const out = maskMessage({
      props: {
        replyTo: `https://svc:${SECRET}@host/reply`,
        contentType: 'application/json',
        priority: 5,
        messageId: undefined,
      },
      body: text(''),
    });
    expect(out.props).toEqual({
      replyTo: `https://${REDACTED}@host/reply`,
      contentType: 'application/json',
      priority: 5,
    });
    expect(out.masked).toEqual(['prop:replyTo']);
  });
});

describe('M1-19 mask: body', () => {
  it('M1-19 mask: a JSON body is walked: secret keys lose their value at any depth, other values stay', () => {
    const body = JSON.stringify({
      user: 'ann',
      password: SECRET,
      nested: { list: [{ api_key: SECRET }, { ok: 1 }], note: 'fine' },
      url: `postgres://ann:${SECRET}@db/x`,
    });
    const out = maskBody(text(body));
    expect(out.kind).toBe('text');
    if (out.kind !== 'text') return;
    expect(out.changed).toBe(true);
    expect(out.value).not.toContain(SECRET);
    expect(JSON.parse(out.value)).toEqual({
      user: 'ann',
      password: REDACTED,
      nested: { list: [{ api_key: REDACTED }, { ok: 1 }], note: 'fine' },
      url: `postgres://${REDACTED}@db/x`,
    });
  });

  it('M1-19 mask: a JSON body with nothing to mask keeps its layout and its numbers as typed', () => {
    const body =
      '{\n  "id": 12345678901234567890,\n  "name":   "ann",\n  "n": 1.50\n}';
    expect(maskBodyText(body)).toEqual({ value: body, changed: false });
  });

  it('M1-19 mask: a secret under an escaped spelling is still found in a JSON body', () => {
    const body = `{"pass\\u0077ord":"${SECRET}"}`;
    const out = maskBodyText(body);
    expect(out.changed).toBe(true);
    expect(out.value).toBe(`{"password":"${REDACTED}"}`);
  });

  it('M1-19 mask: free text goes through the text rules: name=value, Basic, Bearer, JWT, URIs and queries', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl';
    const body = [
      `password=${SECRET}`,
      `Authorization: Basic ${Buffer.from(`ann:${SECRET}`).toString('base64')}`,
      `Authorization: Bearer ${SECRET}`,
      `jwt ${jwt}`,
      `amqps://ann:${SECRET}@broker:5671/v`,
      `https://host/path?access_token=${SECRET}&x=1`,
      'plain words stay',
    ].join('\n');
    const out = maskBodyText(body);
    expect(out.changed).toBe(true);
    expect(out.value).not.toContain(SECRET);
    expect(out.value).not.toContain(jwt);
    expect(out.value).toContain('plain words stay');
    expect(out.value).toContain('&x=1');
  });

  it('M1-19 mask: text that only looks like JSON is masked as text', () => {
    const out = maskBodyText(`{"password": "${SECRET}", broken`);
    expect(out.changed).toBe(true);
    expect(out.value).not.toContain(SECRET);
  });

  it('M1-19 mask: a byte order mark and unusual but valid text survive', () => {
    const bom = '﻿hello é中';
    const out = maskBody(text(bom));
    expect(out).toEqual({ kind: 'text', value: bom, changed: false });
  });

  it('M1-19 mask: the 64 KiB limit is inclusive, bytes (not characters) are counted', () => {
    const atLimit = maskBody(new Uint8Array(MASK_MAX_BODY_BYTES).fill(97));
    expect(atLimit.kind).toBe('text');
    const over = maskBody(new Uint8Array(MASK_MAX_BODY_BYTES + 1).fill(97));
    expect(over).toEqual({ kind: 'omitted', reason: 'too-large' });
    // 32,769 two-byte characters are 65,538 bytes.
    expect(maskBody(text('é'.repeat(32_769)))).toEqual({
      kind: 'omitted',
      reason: 'too-large',
    });
    // The size is checked before the content: a big binary body is "too large", not "binary".
    expect(
      maskBody(new Uint8Array(MASK_MAX_BODY_BYTES + 1).fill(0xff)),
    ).toEqual({
      kind: 'omitted',
      reason: 'too-large',
    });
  });

  it('M1-19 mask: bytes that are not UTF-8 text, or hold a NUL, are binary', () => {
    expect(maskBody(Uint8Array.from([0xff, 0xfe, 0x41]))).toEqual({
      kind: 'omitted',
      reason: 'binary',
    });
    expect(maskBody(text('ab\0cd'))).toEqual({
      kind: 'omitted',
      reason: 'binary',
    });
    expect(maskBody(new Uint8Array(0))).toEqual({
      kind: 'text',
      value: '',
      changed: false,
    });
  });

  it('M1-19 mask: a long unbroken run does not stall the event loop and is never passed on', () => {
    const run = 'a'.repeat(MASK_MAX_BODY_BYTES);
    const started = performance.now();
    const plain = maskBody(text(run));
    const jwtLike = maskBody(text('eyJ'.repeat(21_000)));
    const json = maskBody(text(JSON.stringify({ blob: 'x:'.repeat(30_000) })));
    expect(performance.now() - started).toBeLessThan(750);
    expect(plain).toEqual({
      kind: 'text',
      value: LONG_RUN_MARKER,
      changed: true,
    });
    expect(jwtLike).toMatchObject({ kind: 'text', changed: true });
    expect(json).toMatchObject({ kind: 'text', changed: true });
    // A run just under the limit is passed to the rules unchanged.
    expect(maskString('b'.repeat(1024))).toBe('b'.repeat(1024));
    expect(maskString('b'.repeat(1025))).toBe(LONG_RUN_MARKER);
  });

  it('M1-19 mask: a property whose name says a secret loses its value whatever its type', () => {
    const out = maskMessage({
      props: { password: SECRET, token: 5, correlationId: 'c-1' },
      body: text(''),
    });
    expect(out.props).toEqual({
      password: REDACTED,
      token: REDACTED,
      correlationId: 'c-1',
    });
    expect(out.masked).toEqual(['prop:password', 'prop:token']);
  });

  it('M1-19 mask: JSON nested far deeper than the stack is cut, not followed and not thrown on', () => {
    for (const depth of [5_000, 20_000, 32_000]) {
      const deep = `${'['.repeat(depth)}"${SECRET}"${']'.repeat(depth)}`;
      const out = maskBody(text(deep));
      expect(out).toMatchObject({ kind: 'text', changed: true });
      if (out.kind === 'text') expect(out.value).not.toContain(SECRET);
    }
  });

  it('M1-19 mask: JSON nested deeper than the walk is cut, not followed', () => {
    const deep = `${'['.repeat(40)}"${SECRET}"${']'.repeat(40)}`;
    const out = maskBodyText(deep);
    expect(out.changed).toBe(true);
    expect(out.value).not.toContain(SECRET);
  });
});

describe('M1-19 mask: laws', () => {
  const printable = fc.string({ maxLength: 200 });
  const jsonValue = fc.jsonValue({ maxDepth: 4 });
  const secretKeys = fc.constantFrom(
    'password',
    'token',
    'x',
    'api_key',
    'name',
  );

  it('M1-19 mask: masking twice is masking once (text, JSON, headers)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          printable,
          jsonValue.map((v) => JSON.stringify(v)),
          fc
            .dictionary(secretKeys, printable, { maxKeys: 4 })
            .map((o) => JSON.stringify(o)),
        ),
        (input) => {
          const once = maskBodyText(input).value;
          expect(maskBodyText(once).value).toBe(once);
        },
      ),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom('authorization', 'x-a', 'x-api-key', 'trace'),
          printable.map(str),
          { maxKeys: 4 },
        ),
        printable,
        (headers, body) => {
          const once = maskMessage({
            props: {},
            headers,
            body: text(body),
          });
          const twice = remaskMessage(once);
          expect(twice.headers).toEqual(once.headers);
          expect(twice.body).toEqual(once.body);
          expect(twice.masked).toEqual(once.masked);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('M1-19 mask: the secret never survives in a header, a property or a body, however it is nested', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('password', 'token', 'client_secret', 'api_key'),
        fc.string({ minLength: 1, maxLength: 3 }),
        (key, extra) => {
          const secret = `${SECRET}${extra}`;
          const out = maskMessage({
            props: {},
            headers: {
              h: {
                t: 'table',
                v: [{ name: key, value: str(secret) }],
              },
            },
            body: text(JSON.stringify({ a: { b: [{ [key]: secret }] } })),
          });
          expect(JSON.stringify(out)).not.toContain(SECRET);
        },
      ),
      { numRuns: 100 },
    );
  });
});
