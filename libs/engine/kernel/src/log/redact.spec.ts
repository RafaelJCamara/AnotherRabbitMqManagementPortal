import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isSensitiveKey,
  REDACTED,
  redactLine,
  redactText,
  redactValue,
} from './redact.ts';

// Canary secrets: distinctive strings that must never appear in output.
const JWT =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjYW5hcnktdXNlciIsInNjb3BlIjoiYWRtaW4ifQ.c2lnbmF0dXJlLWNhbmFyeS0xMjM0NQ';

describe('redactText', () => {
  it('masks the credentials of a URI and keeps the rest', () => {
    expect(redactText('amqps://u:p@h')).toBe(`amqps://${REDACTED}@h`);
    expect(redactText('open amqp://guest:guest@10.0.0.5:5672/%2F now')).toBe(
      `open amqp://${REDACTED}@10.0.0.5:5672/%2F now`,
    );
    expect(redactText('https://abc123token@example.com/path')).toBe(
      `https://${REDACTED}@example.com/path`,
    );
  });

  it('masks a password that contains reserved characters up to the last @ of the authority', () => {
    expect(redactText('amqp://svc:p@ss:w0rd@broker:5672')).toBe(
      `amqp://${REDACTED}@broker:5672`,
    );
  });

  it('masks shovel and federation URIs, including secret query parameters', () => {
    const text =
      'src-uri=amqps://shovel:S0urce-Pw@a.example:5671/vh?heartbeat=30&password=Q-pass&cacertfile=/etc/ca.pem dest-uri=amqp://dst:D3st@b.example';
    const out = redactText(text);
    expect(out).not.toContain('S0urce-Pw');
    expect(out).not.toContain('Q-pass');
    expect(out).not.toContain('D3st');
    expect(out).toContain('heartbeat=30');
    expect(out).toContain('cacertfile=/etc/ca.pem');
  });

  it('masks query parameters that carry a secret and keeps the others', () => {
    expect(redactText('GET /x?page=2&token=abc.def&sort=asc')).toBe(
      `GET /x?page=2&token=${REDACTED}&sort=asc`,
    );
    expect(redactText('https://h/p?keyfile=/k.pem')).toBe(
      'https://h/p?keyfile=/k.pem',
    );
  });

  it('masks a JWT wherever it appears', () => {
    expect(redactText(`token ${JWT} end`)).toBe(`token ${REDACTED} end`);
    expect(redactText(`x=${JWT}`)).toBe(`x=${REDACTED}`);
  });

  it('masks a Bearer value, in any case', () => {
    expect(redactText('Authorization: Bearer abcDEF123456')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactText('bearer opaque-token-value')).toBe(`bearer ${REDACTED}`);
  });

  it('leaves ordinary text alone', () => {
    const text =
      'queue orders on vhost / has 12 messages at http://localhost:15672/api/queues';
    expect(redactText(text)).toBe(text);
  });
});

describe('isSensitiveKey', () => {
  it('flags credential-like names in any casing and separator style', () => {
    for (const key of [
      'authorization',
      'Authorization',
      'cookie',
      'Set-Cookie',
      'password',
      'db_password',
      'accessToken',
      'refresh-token',
      'client.secret',
      'apiKey',
      'api_key',
      'privateKey',
      'x-auth-request-user',
      'x-api-key',
      'x-amz-security-token',
      'x-session',
      'body',
      'payload',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('does not flag ordinary names', () => {
    for (const key of [
      'msg',
      'level',
      'queue',
      'vhost',
      'x-request-id',
      'x-forwarded-for',
      'bodyBytes',
      'status',
    ]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe('redactValue', () => {
  it('masks sensitive keys at any depth and scrubs every string', () => {
    const out = redactValue({
      req: {
        headers: {
          authorization: 'Basic Y2FuYXJ5OnB3',
          'x-forwarded-access-token': 'plain-canary',
          'x-trace': `claims ${JWT}`,
        },
        url: 'amqps://u:p@h/vh',
      },
      list: [{ password: 'pw-canary' }, 'Bearer abcdefgh1234'],
      count: 3,
    });
    expect(out).toEqual({
      req: {
        headers: {
          authorization: REDACTED,
          'x-forwarded-access-token': REDACTED,
          'x-trace': `claims ${REDACTED}`,
        },
        url: `amqps://${REDACTED}@h/vh`,
      },
      list: [{ password: REDACTED }, `Bearer ${REDACTED}`],
      count: 3,
    });
  });

  it('keeps booleans and null under a sensitive key, and masks numbers', () => {
    expect(
      redactValue({ hasToken: true, tokenAt: null, passwordPin: 1234 }),
    ).toEqual({ hasToken: true, tokenAt: null, passwordPin: REDACTED });
  });

  it('does not change its input', () => {
    const input = { password: 'x', nested: { token: 'y' } };
    redactValue(input);
    expect(input).toEqual({ password: 'x', nested: { token: 'y' } });
  });

  it('drops values nested deeper than it will inspect (fail closed)', () => {
    let deep: unknown = { password: 'deep-canary' };
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(JSON.stringify(redactValue(deep))).not.toContain('deep-canary');
  });

  it('turns a __proto__ key into a plain property', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"polluted":"yes"}}');
    const out = redactValue(parsed) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('redactLine', () => {
  it('redacts a JSON line and keeps it one valid JSON line', () => {
    const line = `${JSON.stringify({ level: 'info', msg: 'dial amqps://u:p@h', password: 'pw' })}\n`;
    const out = redactLine(line);
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out)).toEqual({
      level: 'info',
      msg: `dial amqps://${REDACTED}@h`,
      password: REDACTED,
    });
  });

  it('redacts a line that is not JSON as text', () => {
    expect(redactLine('connect amqps://u:p@h failed')).toBe(
      `connect amqps://${REDACTED}@h failed`,
    );
  });

  it('copes with a secret that needs JSON escaping', () => {
    const line = JSON.stringify({ msg: 'amqp://u:pa"ss\\w@h' });
    const out = redactLine(line);
    expect(JSON.parse(out)).toEqual({ msg: `amqp://${REDACTED}@h` });
  });

  it('property: no canary survives, however it is embedded', () => {
    const word = fc.stringMatching(/^[A-Za-z0-9]{10,24}$/);
    const base64Url = fc.stringMatching(/^[A-Za-z0-9_-]{12,40}$/);
    fc.assert(
      fc.property(
        word,
        base64Url,
        base64Url,
        base64Url,
        fc.constantFrom('amqp', 'amqps', 'http', 'https'),
        (suffix, a, b, c, scheme) => {
          const secret = `CanarySecret${suffix}`;
          const bearer = `CanaryBearer${a}`;
          const jwt = `eyJ${a}.eyJ${b}.${c}`;
          const line = JSON.stringify({
            level: 'info',
            msg: `connecting ${scheme}://user:${secret}@broker.example:5671/%2F?password=${secret}Q`,
            err: { message: `failed with Bearer ${bearer}`, stack: jwt },
            headers: {
              'x-custom-claims': `claims=${jwt}`,
              authorization: bearer,
            },
            shovel: {
              'src-uri': [`amqp://s:${secret}@a`, `amqps://${secret}@b`],
            },
            password: secret,
          });
          const out = redactLine(line);
          for (const canary of [secret, bearer, jwt, `eyJ${a}`, `eyJ${b}`]) {
            expect(out).not.toContain(canary);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
