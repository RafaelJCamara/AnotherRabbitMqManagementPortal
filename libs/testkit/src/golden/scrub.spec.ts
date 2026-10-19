import { describe, expect, it } from 'vitest';

import { CANARY_SECRET, SCRUBBED, createScrubber, findLeaks } from './scrub.ts';

const hosts = {
  '3f9a1c2d4e5b': 'lab-node',
  'broker-lab-4.3.6-ab12cd34': 'lab-container',
};

describe('scrubber', () => {
  it('replaces the recording host by the name the caller gave, keeping the node-name shape', () => {
    const { json, text } = createScrubber({ hosts });
    expect(json({ node: 'rabbit@3f9a1c2d4e5b', name: 'lavin' })).toEqual({
      node: 'rabbit@lab-node',
      name: 'lavin',
    });
    expect(text('node="rabbit@3f9a1c2d4e5b"')).toBe('node="rabbit@lab-node"');
    expect(json({ 'rabbit@3f9a1c2d4e5b': 1 })).toEqual({
      'rabbit@lab-node': 1,
    });
    expect(text('broker-lab-4.3.6-ab12cd34')).toBe('lab-container');
  });

  it('maps addresses to documentation ranges in order of first appearance, and keeps loopback', () => {
    const { text } = createScrubber();
    expect(
      text(
        '172.17.0.1:53514 -> 172.17.0.2:5672, 172.17.0.1, 127.0.0.1, 0.0.0.0, 10.1.2.3',
      ),
    ).toBe(
      '192.0.2.1:53514 -> 192.0.2.2:5672, 192.0.2.1, 127.0.0.1, 0.0.0.0, 192.0.2.3',
    );
    expect(text('fd00:0:0:0:0:0:0:5 and fd00:0:0:0:0:0:0:5')).toBe(
      '2001:db8::1 and 2001:db8::1',
    );
  });

  it('is idempotent: scrubbing what it wrote changes nothing, so a value scrubbed twice keeps one address', () => {
    const { text, path } = createScrubber({ hosts });
    const once = text(
      '172.17.0.1:5000 -> 172.17.0.2:5672 on rabbit@3f9a1c2d4e5b',
    );
    expect(text(once)).toBe(once);
    expect(
      path(path('/api/connections/172.17.0.9%3A1%20-%3E%20172.17.0.2%3A5672')),
    ).toBe(path('/api/connections/172.17.0.9%3A1%20-%3E%20172.17.0.2%3A5672'));
  });

  it('scrubs a request path segment by segment, where an address is glued to a percent escape', () => {
    const { text, path } = createScrubber();
    // `%20172...` hides the address from a plain text scrub: the digit of `%20` precedes it.
    const raw =
      '/api/connections/172.17.0.1%3A53514%20-%3E%20172.17.0.2%3A5672';
    expect(text(raw)).toContain('%20172.17.0.2');
    expect(path(raw)).toBe(
      '/api/connections/192.0.2.1%3A53514%20-%3E%20192.0.2.2%3A5672',
    );
    // The mapping is the one the bodies get, a segment without a secret is kept byte for byte,
    // and the query is not touched.
    expect(text('172.17.0.1')).toBe('192.0.2.1');
    expect(path('/api/queues/%2F/a%2Fb?name=172.17.0.1&page=1')).toBe(
      '/api/queues/%2F/a%2Fb?name=172.17.0.1&page=1',
    );
    expect(path('/api/x/%E0%A4%A')).toBe('/api/x/%E0%A4%A');
  });

  it('does not take a four-part version for an address', () => {
    const { json, text } = createScrubber();
    expect(json({ erlang_version: '26.2.5.14', other: '26.2.5.14' })).toEqual({
      erlang_version: '26.2.5.14',
      other: '192.0.2.1',
    });
    expect(text('erlang_version="27.3.4.2"')).toBe('erlang_version="27.3.4.2"');
  });

  it('is deterministic: the same input and hosts give the same output', () => {
    const input = {
      a: '10.0.0.7 rabbit@3f9a1c2d4e5b',
      b: ['10.0.0.8', '10.0.0.7'],
    };
    const first = createScrubber({ hosts }).json(input);
    const second = createScrubber({ hosts }).json(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual({
      a: '192.0.2.1 rabbit@lab-node',
      b: ['192.0.2.2', '192.0.2.1'],
    });
  });

  it('replaces the value of a key that names a secret, at any depth, and keeps booleans and null', () => {
    const out = createScrubber().json({
      name: 'guest',
      password_hash: '+pHuxkR9fCyrrwXjOD4BP4XbzO3l8LJr8YkThMgJ0yVHFRE+',
      hashing_algorithm: 'rabbit_password_hashing_sha256',
      nested: [{ client_secret: 's3cr3t-value', token: { a: 1 } }],
      oauth_client_secret: 'x-secret-value',
      password: null,
      cookie: false,
      auth_mechanism: 'PLAIN',
    });
    expect(out).toEqual({
      name: 'guest',
      password_hash: SCRUBBED,
      hashing_algorithm: 'rabbit_password_hashing_sha256',
      nested: [{ client_secret: SCRUBBED, token: SCRUBBED }],
      oauth_client_secret: SCRUBBED,
      password: null,
      cookie: false,
      auth_mechanism: 'PLAIN',
    });
  });

  it('removes secret-shaped strings wherever they are', () => {
    const { text } = createScrubber({ secrets: ['hunter2-literal'] });
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJsYWIifQ.c2lnbmF0dXJlLXZhbHVl';
    const input = [
      `token ${jwt}`,
      'Authorization: Bearer abcdEFGH12345678',
      'Authorization: Basic Z3Vlc3Q6Z3Vlc3Q=',
      'amqp://golden:letmein@broker.example:5672/vhost',
      `-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----`,
      `the password is ${CANARY_SECRET} and hunter2-literal`,
    ].join('\n');
    const out = text(input);
    expect(out).not.toContain('eyJ');
    expect(out).not.toContain('abcdEFGH');
    expect(out).not.toContain('Z3Vlc3Q6');
    expect(out).not.toContain('letmein');
    expect(out).not.toContain('MIIEvQ');
    expect(out).not.toContain(CANARY_SECRET);
    expect(out).not.toContain('hunter2-literal');
    expect(out).toContain(`amqp://${SCRUBBED}@broker.example`);
    expect(findLeaks(out, ['hunter2-literal'])).toEqual([]);
  });

  it('replaces the home directory of a user', () => {
    const { text } = createScrubber();
    expect(
      text('/home/rafael/.erlang.cookie and C:\\Users\\rafae\\Projects'),
    ).toBe('/home/user/.erlang.cookie and C:\\Users\\user\\Projects');
    expect(text('/var/lib/rabbitmq/mnesia')).toBe('/var/lib/rabbitmq/mnesia');
  });

  it('leaves plain data alone: numbers, booleans, names, versions', () => {
    const value = {
      rabbitmq_version: '4.3.6',
      disable_stats: false,
      messages: 5,
      queue: 'golden.classic',
      listeners: [{ port: 5672, ip_address: '::' }],
    };
    expect(createScrubber().json(value)).toEqual(value);
  });
});

describe('findLeaks', () => {
  it('flags a planted secret, a JWT and credentials in a URL, and passes clean text', () => {
    expect(findLeaks(`x ${CANARY_SECRET} y`)).toContain('a planted secret');
    expect(findLeaks('canary-secret-anything')).toContain('canary secret');
    expect(findLeaks('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJsYWIifQ.c2ln')).toContain(
      'JWT',
    );
    expect(findLeaks('amqp://user:pw@host/')).toContain('credentials in a URL');
    expect(findLeaks('{"queues":3,"password_hash":"<scrubbed>"}')).toEqual([]);
    expect(findLeaks('amqp://<scrubbed>@host/')).toEqual([]);
  });
});
