import { describe, expect, it } from 'vitest';

import { sealedEvidence } from '../testing/lab.ts';
import { findSecrets } from './secrets.ts';

const reasons = (value: unknown, known: string[] = []): string[] =>
  findSecrets(value, known).map((finding) => finding.reason);

describe('I-10 evidence never records a secret', () => {
  it('a recorded artefact is clean', () => {
    expect(findSecrets(sealedEvidence(), ['guest-password'])).toEqual([]);
  });

  it.each([
    [
      'a URL with a login',
      'amqps://user:hunter2@broker.example:5671/',
      'a URL with a user name or password',
    ],
    [
      'a URL with an empty user name',
      'amqp://:hunter2@host',
      'a URL with a user name or password',
    ],
    [
      'a bearer token',
      'Authorization failed for Bearer abcdefgh12345678',
      'a bearer token',
    ],
    [
      'a basic header',
      'sent Basic Z3Vlc3Q6Z3Vlc3Q=',
      'a basic authorisation header',
    ],
    [
      'a JWT',
      'token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln',
      'a JSON web token',
    ],
    ['a private key', '-----BEGIN RSA PRIVATE KEY-----', 'a private key'],
  ])('finds %s in a step result', (_name, text, reason) => {
    expect(reasons({ steps: [{ result: { text } }] })).toContain(reason);
  });

  it('reports where it found the secret', () => {
    const [finding] = findSecrets({
      steps: [{ result: { text: 'amqp://a:b@h' } }],
    });

    expect(finding?.path).toBe('steps[0].result.text');
  });

  it('does not take a plain URL, a version or a delivery count for a secret', () => {
    expect(
      reasons({
        text: 'amqp://127.0.0.1:5672 and http://127.0.0.1:15672/api/overview',
        'x-delivery-count': 2,
        digest: `sha256:${'a'.repeat(64)}`,
        note: 'Bearer',
      }),
    ).toEqual([]);
  });

  it.each([
    'password',
    'Password',
    'secret',
    'accessToken',
    'authorization',
    'api-key',
    'apiKey',
    'private_key',
    'credentials',
  ])('refuses a key named %s whatever its value', (key) => {
    expect(reasons({ nested: { [key]: 'x' } })).toContain(
      'a key that names a credential',
    );
  });

  it('finds a secret in a key, not only in a value', () => {
    expect(reasons({ 'amqp://u:p@h': 1 })).toContain(
      'a URL with a user name or password',
    );
  });

  it('finds a value the run knows to be secret, in every encoding a URL, a header or a dump uses', () => {
    const secret = 's3cr3t/value+x';
    const encodings = [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
      Buffer.from(secret).toString('hex'),
    ];

    for (const encoding of encodings) {
      expect(
        reasons({ steps: [{ result: { text: `before ${encoding} after` } }] }, [
          secret,
        ]),
      ).toContain('a value this run knows to be secret');
    }
  });

  it('ignores an empty known secret (it would match everything)', () => {
    expect(findSecrets({ text: 'anything' }, [''])).toEqual([]);
  });

  it('walks arrays and nested objects', () => {
    expect(reasons({ a: [[{ b: 'Bearer abcdefgh12345678' }]] })).toContain(
      'a bearer token',
    );
  });
});
