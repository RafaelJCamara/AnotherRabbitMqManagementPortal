import { describe, expect, it } from 'vitest';

import { parseConnectionUri, UriError } from './uri';

describe('parseConnectionUri', () => {
  it('AC-1 reads host, port, TLS, user, password and the vhost of an amqps URI (%2F is a slash)', () => {
    expect(parseConnectionUri('amqps://u:p@host:5671/%2Fprod')).toEqual({
      kind: 'amqp',
      tls: true,
      host: 'host',
      port: 5671,
      vhost: '/prod',
      username: 'u',
      password: 'p',
    });
  });

  it('reads the default vhost from no path, from a lone slash and from %2F, and leaves the port out when none is written', () => {
    for (const text of ['amqp://host', 'amqp://host/', 'amqp://host/%2F']) {
      expect(parseConnectionUri(text)).toEqual({
        kind: 'amqp',
        tls: false,
        host: 'host',
        vhost: '/',
      });
    }
  });

  it('decodes the user, the password and the vhost once, and keeps a decoded % as it is', () => {
    expect(
      parseConnectionUri('amqp://us%40er:p%2Fa%3Ass%25@host/v%2Fhost%25'),
    ).toMatchObject({
      username: 'us@er',
      password: 'p/a:ss%',
      vhost: 'v/host%',
    });
  });

  it('reads a user without a password, and an IPv6 address without its brackets', () => {
    expect(parseConnectionUri('amqp://guest@[::1]:5673/app')).toMatchObject({
      host: '::1',
      port: 5673,
      username: 'guest',
      vhost: 'app',
    });
    expect(
      parseConnectionUri('amqp://guest@[::1]/app').password,
    ).toBeUndefined();
  });

  it('reads the management URL of a broker: scheme, host, port and the path prefix in front of /api', () => {
    expect(
      parseConnectionUri('https://admin:s3cret@mq.example:15671/rabbitmq/'),
    ).toEqual({
      kind: 'http',
      tls: true,
      host: 'mq.example',
      port: 15671,
      pathPrefix: '/rabbitmq',
      username: 'admin',
      password: 's3cret',
    });
    // A default port is not written down by the URL class, so none is reported.
    expect(parseConnectionUri('https://mq.example/')).toEqual({
      kind: 'http',
      tls: true,
      host: 'mq.example',
    });
    expect(parseConnectionUri('http://mq.example:80')).toMatchObject({
      tls: false,
      host: 'mq.example',
    });
  });

  it('ignores a query string, and lower-cases an HTTP host as the URL class does', () => {
    expect(parseConnectionUri('amqp://host/vh?heartbeat=30')).toMatchObject({
      vhost: 'vh',
    });
    expect(parseConnectionUri('http://MQ.Example').host).toBe('mq.example');
  });

  it.each([
    ['a scheme that is not one', 'ftp://host/'],
    ['no scheme', 'host:5672'],
    ['text', 'not a uri'],
    ['an empty string', ''],
    ['a port that is not one', 'amqp://host:99999/'],
    ['a vhost with an unescaped slash', 'amqp://host/a/b'],
    ['a broken % escape in the password', 'amqp://u:%zz@host/'],
    ['a broken % escape in the vhost', 'amqp://host/%zz'],
    ['no host', 'amqp:///vhost'],
  ])('refuses %s with a UriError', (_name, text) => {
    expect(() => parseConnectionUri(text)).toThrow(UriError);
  });

  it('never puts the input, which may hold a password, in an error', () => {
    for (const text of [
      'ftp://user:PW-CANARY-12345@host/',
      'amqp://user:PW-CANARY-12345%zz@host/',
      'amqp://user:PW-CANARY-12345@host:99999/',
      'amqp://user:PW-CANARY-12345@host/a/b',
    ]) {
      try {
        parseConnectionUri(text);
        throw new Error('expected a UriError');
      } catch (error) {
        expect(error).toBeInstanceOf(UriError);
        expect((error as UriError).message).not.toContain('PW-CANARY');
        expect((error as UriError).message).not.toContain('user');
        expect(String((error as UriError).stack)).not.toContain('PW-CANARY');
      }
    }
  });
});
