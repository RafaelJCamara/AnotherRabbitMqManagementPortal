// The guards as pure functions: what each one accepts and refuses, without a server.
import { describe, expect, it } from 'vitest';

import { assertSecret, parseBearer, sameSecret } from '../auth/credentials.ts';
import { createCarrierAuth } from '../auth/carrier.ts';
import { createLocalTokenAuth } from '../auth/local-token.ts';
import { createHostPolicy } from './host-origin.ts';
import { checkJsonOnly } from './json-only.ts';
import { checkSecFetch } from './sec-fetch.ts';

const SECRET = 'A'.repeat(43);

describe('Host and Origin policy', () => {
  const policy = createHostPolicy(['https://App.Example.com']);
  const accepts = (
    headers: Record<string, string>,
    viaSocket = true,
  ): boolean => {
    try {
      policy.check(headers, viaSocket);
      return true;
    } catch {
      return false;
    }
  };

  it('AC-2 accepts loopback names on any port and the listed public origin, exactly', () => {
    for (const host of [
      'localhost',
      'LOCALHOST:8765',
      '127.0.0.1:1',
      '127.0.0.1:65535',
      '[::1]:8765',
      'app.example.com',
    ]) {
      expect(accepts({ host }), host).toBe(true);
    }
  });

  it('AC-2 refuses every spelling that is not exactly an allowed name', () => {
    for (const host of [
      '',
      'example.com',
      'app.example.com:8443',
      'app.example.com.',
      'xapp.example.com',
      'sub.app.example.com',
      '127.0.0.1:65536',
      '127.0.0.1:0000099999',
      '127.0.0.1:',
      '127.0.0.1.',
      '127.0.0.1:80:80',
      '127.1',
      '0.0.0.0',
      '0x7f.0.0.1',
      '2130706433',
      '[::ffff:127.0.0.1]',
      '[::]',
      '::1',
      'localhost.localdomain',
      'localhost@evil.example',
      'evil.example#127.0.0.1',
      '127.0.0.1\u0000',
      '127.0.0.1 evil',
      'engine.internal',
    ]) {
      expect(accepts({ host }), JSON.stringify(host)).toBe(false);
    }
    expect(accepts({})).toBe(false);
  });

  it('AC-2 lets the tunnel use engine.internal, and nothing that arrived over a socket', () => {
    expect(accepts({ host: 'engine.internal' }, false)).toBe(true);
    expect(accepts({ host: 'engine.internal' }, true)).toBe(false);
    expect(accepts({ host: 'engine.internal.evil.example' }, false)).toBe(
      false,
    );
  });

  it('AC-2 accepts an Origin only when it is this Host as an origin', () => {
    expect(
      accepts({ host: '127.0.0.1:8765', origin: 'http://127.0.0.1:8765' }),
    ).toBe(true);
    expect(
      accepts({ host: 'app.example.com', origin: 'https://app.example.com' }),
    ).toBe(true);
    for (const origin of [
      'null',
      '',
      'https://127.0.0.1:8765',
      'http://127.0.0.1:8766',
      'http://localhost:8765',
      'http://127.0.0.1:8765/',
      'http://app.example.com',
      'https://evil.example',
      'http://127.0.0.1:8765.evil.example',
    ]) {
      expect(accepts({ host: '127.0.0.1:8765', origin }), origin).toBe(false);
    }
    expect(
      accepts({ host: 'app.example.com', origin: 'http://app.example.com' }),
    ).toBe(false);
  });

  it('AC-2 refuses to be configured with anything but plain origins', () => {
    for (const bad of [
      'app.example.com',
      'ftp://app.example.com',
      'https://app.example.com/path',
      'https://user:pw@app.example.com',
      'https://app.example.com?x=1',
      'javascript:alert(1)',
    ]) {
      expect(() => createHostPolicy([bad]), bad).toThrow();
    }
  });
});

describe('Sec-Fetch-Site', () => {
  const refused = (headers: Record<string, string>, navigation = false) => {
    try {
      checkSecFetch(headers, navigation);
      return false;
    } catch {
      return true;
    }
  };

  it('AC-2 accepts no header and same-origin, refuses everything else', () => {
    expect(refused({})).toBe(false);
    expect(refused({ 'sec-fetch-site': 'same-origin' })).toBe(false);
    for (const site of [
      'cross-site',
      'same-site',
      'none',
      'Cross-Site',
      '',
      'same-origin, cross-site',
    ]) {
      expect(refused({ 'sec-fetch-site': site }), site).toBe(
        site !== 'same-origin',
      );
    }
  });

  it('AC-2 accepts none only for a navigation to the UI', () => {
    expect(
      refused({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' }, true),
    ).toBe(false);
    expect(
      refused(
        { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
        false,
      ),
    ).toBe(true);
    expect(
      refused({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors' }, true),
    ).toBe(true);
    expect(refused({ 'sec-fetch-site': 'none' }, true)).toBe(true);
    expect(
      refused(
        { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
        true,
      ),
    ).toBe(true);
  });
});

describe('JSON-only', () => {
  const statusOf = (
    headers: Record<string, string>,
    method = 'POST',
  ): number | undefined => {
    try {
      checkJsonOnly(headers, method);
      return undefined;
    } catch (error) {
      return (error as { status?: number }).status;
    }
  };

  it('AC-2 needs a media type only when there is a body', () => {
    expect(statusOf({})).toBeUndefined();
    expect(statusOf({ 'content-length': '0' })).toBeUndefined();
    expect(statusOf({ 'content-length': '2' })).toBe(415);
    expect(statusOf({ 'transfer-encoding': 'chunked' })).toBe(415);
    expect(
      statusOf({ 'content-length': '2', 'content-type': 'application/json' }),
    ).toBeUndefined();
    expect(
      statusOf({
        'content-length': '2',
        'content-type': 'application/json; charset=UTF-8',
      }),
    ).toBeUndefined();
  });

  it('AC-2 refuses the types a page can send cross-site without a preflight', () => {
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'application/json5',
      'application/json;charset=latin1',
      'application/json, text/plain',
      'text/plain; application/json',
    ]) {
      expect(
        statusOf({ 'content-length': '2', 'content-type': type }),
        type,
      ).toBe(415);
    }
  });

  it('AC-2 refuses a body on GET and HEAD', () => {
    for (const method of ['GET', 'HEAD']) {
      expect(
        statusOf(
          { 'content-length': '2', 'content-type': 'application/json' },
          method,
        ),
      ).toBe(400);
    }
  });
});

describe('credentials', () => {
  it('AC-2 reads a bearer token only in the exact form', () => {
    expect(parseBearer(`Bearer ${SECRET}`)).toBe(SECRET);
    expect(parseBearer(`bearer ${SECRET}`)).toBe(SECRET);
    for (const header of [
      undefined,
      '',
      SECRET,
      `Bearer  ${SECRET}`,
      `Bearer ${SECRET} x`,
      `Bearer ${SECRET}\n`,
      `Bearer ${'a'.repeat(513)}`,
      `Basic ${SECRET}`,
      ['Bearer a', 'Bearer b'],
    ]) {
      expect(parseBearer(header), String(header)).toBeUndefined();
    }
  });

  it('AC-2 compares secrets in full, whatever their length', () => {
    expect(sameSecret(SECRET, SECRET)).toBe(true);
    expect(sameSecret(SECRET, SECRET + 'A')).toBe(false);
    expect(sameSecret(SECRET.slice(1), SECRET)).toBe(false);
    expect(sameSecret('', SECRET)).toBe(false);
    expect(sameSecret('B'.repeat(43), SECRET)).toBe(false);
  });

  it('AC-2 refuses a weak or oddly spelled secret when an authenticator is made', () => {
    for (const weak of [
      '',
      'short',
      'a'.repeat(31),
      'a'.repeat(513),
      `${SECRET}!`,
      `${SECRET} `,
      `${SECRET}\n`,
    ]) {
      expect(() => {
        assertSecret('x', weak);
      }, weak).toThrow(TypeError);
      expect(() => createLocalTokenAuth(weak)).toThrow(TypeError);
      expect(() => createCarrierAuth(weak)).toThrow(TypeError);
    }
  });

  it('AC-2 a local token authenticates only the bearer, a carrier secret only the carrier', () => {
    const local = createLocalTokenAuth(SECRET);
    const carrier = createCarrierAuth(SECRET);
    expect(local({ bearer: SECRET, carrier: undefined })?.kind).toBe(
      'local-token',
    );
    expect(local({ bearer: SECRET, carrier: SECRET })).toBeUndefined();
    expect(local({ bearer: undefined, carrier: SECRET })).toBeUndefined();
    expect(carrier({ bearer: undefined, carrier: SECRET })?.kind).toBe(
      'desktop-user',
    );
    expect(carrier({ bearer: SECRET, carrier: undefined })).toBeUndefined();
    expect(
      carrier({ bearer: undefined, carrier: SECRET + 'x' }),
    ).toBeUndefined();
  });

  it('AC-2 every authentication gives a fresh principal, so one request cannot widen another', () => {
    const local = createLocalTokenAuth(SECRET);
    const first = local({ bearer: SECRET, carrier: undefined });
    const second = local({ bearer: SECRET, carrier: undefined });
    first?.roles.push('admin');
    expect(second?.roles).toEqual([]);
    expect(first).not.toBe(second);
  });
});
