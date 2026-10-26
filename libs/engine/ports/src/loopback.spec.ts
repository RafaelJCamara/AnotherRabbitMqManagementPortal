// M1-23 hardening: the one loopback test shared by the provider config (a name) and the token
// endpoint client (the connected address). Lookalikes must fail; so must forms we do not recognise.
import { describe, expect, it } from 'vitest';

import { isLoopbackAddress, isLoopbackHost } from './loopback';

describe('isLoopbackHost', () => {
  it('M1-23 hardening accepts localhost, [::1] and dotted 127/8 and nothing that merely looks like them', () => {
    for (const host of [
      'localhost',
      '[::1]',
      '127.0.0.1',
      '127.1.2.3',
      '127.255.255.255',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [
      '',
      'LOCALHOST',
      'localhost.',
      'evil.localhost',
      'localhost.evil.test',
      'notlocalhost',
      'localhost-evil',
      '127.0.0.1.evil.test',
      '127.0.0.1.',
      '127.0.0.1a',
      'x127.0.0.1',
      '127.0.0',
      '127.0.0.1.1',
      '127.0.0.256',
      '127.0.0.01',
      '128.0.0.1',
      '10.0.0.1',
      '::1',
      '[::2]',
      '[::ffff:7f00:1]',
      '[::ffff:127.0.0.1]',
      '[0:0:0:0:0:0:0:1]',
      '[::]',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('M1-23 hardening agrees with how a URL normalises the host it is given', () => {
    const host = (text: string): string => new URL(text).hostname;
    expect(isLoopbackHost(host('http://LocalHost:80/t'))).toBe(true);
    expect(isLoopbackHost(host('http://[0:0:0:0:0:0:0:1]/t'))).toBe(true);
    expect(isLoopbackHost(host('http://127.1/t'))).toBe(true);
    expect(isLoopbackHost(host('http://2130706433/t'))).toBe(true);
    expect(isLoopbackHost(host('http://[::ffff:127.0.0.1]/t'))).toBe(false);
    expect(isLoopbackHost(host('http://evil.localhost/t'))).toBe(false);
    expect(isLoopbackHost(host('http://127.0.0.1.evil.test/t'))).toBe(false);
  });
});

describe('isLoopbackAddress', () => {
  it('M1-23 hardening accepts the loopback addresses a socket reports, mapped forms included', () => {
    for (const address of [
      '127.0.0.1',
      '127.9.9.9',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '::FFFF:127.0.0.1',
    ]) {
      expect(isLoopbackAddress(address), address).toBe(true);
    }
  });

  it('M1-23 hardening refuses every other address, a missing one and any form it does not know', () => {
    for (const address of [
      undefined,
      '',
      '203.0.113.9',
      '10.0.0.1',
      '128.0.0.1',
      '0.0.0.0',
      '::',
      '::2',
      '2001:db8::1',
      '::ffff:203.0.113.9',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1.1',
      '::ffff:',
      '127.0.0.1.evil.test',
      'localhost',
      '[::1]',
      // Mapped, hexadecimal: a loopback in fact, but not a form Node reports; fail closed.
      '::ffff:7f00:1',
    ]) {
      expect(isLoopbackAddress(address), String(address)).toBe(false);
    }
  });
});
