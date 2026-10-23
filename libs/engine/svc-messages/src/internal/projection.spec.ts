import { createCanaryScanner } from '@app/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildProjection,
  MAX_BODY_TEXT,
  MAX_META_TEXT,
  type ProjectionInput,
} from './projection';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function input(over: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    envClass: 'dev',
    indexBodies: true,
    exchange: 'orders',
    routingKey: 'orders.created',
    source: 'orders-queue',
    contentType: 'application/json',
    properties: { messageId: 'm-77', correlationId: 'c-1', userId: 'guest' },
    headers: { 'x-tenant': 'acme', Authorization: 'Bearer abcdef123456' },
    body: text('{"status":"shipped","city":"London"}'),
    ...over,
  };
}

describe('capture projection', () => {
  it('M1-09 AC-2 indexes metadata only for prod and for an unset class, never the body', () => {
    const prod = buildProjection(input({ envClass: 'prod' }));

    expect(prod.bodyText).toBeNull();
    expect(prod.metaText).toContain('orders.created');
    expect(prod.metaText).toContain('m-77');
    // Header names are searchable, header values are not (they can carry personal data).
    expect(prod.metaText).toContain('x-tenant');
    expect(prod.metaText).not.toContain('acme');
    expect(prod.metaText).not.toContain('guest');
  });

  it('M1-09 AC-2 indexes the body outside prod, as keys and values, unless the capture says not to', () => {
    const dev = buildProjection(input());
    const off = buildProjection(input({ indexBodies: false }));

    expect(dev.bodyText).toBe('status shipped city London');
    expect(dev.metaText).toContain('acme');
    expect(off.bodyText).toBeNull();
    expect(off.metaText).toContain('orders.created');
  });

  it('M1-09 AC-5 never lets a header that names a credential into the projection', () => {
    const result = buildProjection(input());

    expect(result.metaText).toContain('Authorization');
    expect(result.metaText).not.toContain('abcdef123456');
    expect(result.metaText).not.toContain('Bearer');
  });

  it('M1-09 AC-5 removes secrets from JSON by key, from text by pattern and by exact value', () => {
    const canary = 'CANARY-7f3a9c1e-secret';
    const known = 'hunter2-known-value';
    const json = buildProjection(
      input({
        body: text(
          JSON.stringify({
            user: 'bob',
            password: canary,
            nested: { apiKey: canary, list: [{ token: canary }] },
            note: `call me with ${known}`,
            link: `https://bob:${canary}@host/path`,
          }),
        ),
      }),
      [known],
    );
    const plain = buildProjection(
      input({
        contentType: 'text/plain',
        body: text(
          `login password=${canary} then Authorization: Basic ${btoa('bob:' + canary)} and ${known}\ntoken: ${canary}`,
        ),
      }),
      [known],
    );

    for (const projection of [json, plain]) {
      const all = `${projection.metaText} ${projection.bodyText ?? ''}`;
      expect(all).not.toContain(canary);
      expect(all).not.toContain(known);
      expect(all).not.toContain(btoa('bob:' + canary));
      expect(createCanaryScanner([canary, known]).scan(all)).toEqual([]);
    }
    expect(json.bodyText).toContain('bob');
    expect(json.bodyText).toContain('REDACTED');
    expect(plain.bodyText).toContain('login');
  });

  it('M1-09 AC-5 removes a known secret in every encoding the canary scanner knows', () => {
    const secret = 'S3cr3t-Value-12345';
    const forms = [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('hex'),
      Buffer.from(secret).toString('hex').toUpperCase(),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
      JSON.stringify(secret).slice(1, -1),
    ];

    for (const form of forms) {
      const result = buildProjection(
        input({ contentType: 'text/plain', body: text(`value is ${form} ok`) }),
        [secret],
      );
      expect(result.bodyText).not.toContain(form);
      expect(result.bodyText).toContain('value is');
    }
  });

  it('M1-09 AC-5 property: no body text or key name leaves a known secret in the projection', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 80 }),
        fc.stringMatching(/^[A-Za-z0-9]{12,24}$/),
        fc.string({ minLength: 0, maxLength: 80 }),
        (before, secret, after) => {
          const result = buildProjection(
            input({
              contentType: 'text/plain',
              routingKey: `${before} ${secret}`,
              body: text(`${before} ${secret} ${after}`),
            }),
            [secret],
          );
          const all = `${result.metaText} ${result.bodyText ?? ''}`;
          expect(all).not.toContain(secret);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('M1-09 AC-2 leaves out a body that is not text, is empty, or is over 64 KiB, and still indexes the metadata', () => {
    const binary = buildProjection(
      input({ body: Uint8Array.from([0xff, 0xfe, 0x00]) }),
    );
    const nul = buildProjection(input({ body: text('abc\u0000def') }));
    const empty = buildProjection(input({ body: new Uint8Array(0) }));
    const big = buildProjection(
      input({ body: new Uint8Array(64 * 1024 + 1).fill(97) }),
    );

    for (const result of [binary, nul, empty, big]) {
      expect(result.bodyText).toBeNull();
      expect(result.metaText).toContain('orders');
    }
  });

  it('M1-09 AC-5 bounds its work and its output on hostile text (I-5, I-6)', () => {
    const longRun = 'a'.repeat(60_000) + ' tail';
    const manyKeys = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 5000 }, (_, i) => [`k${String(i)}`, i]),
      ),
    );
    const deep = '['.repeat(2000) + ']'.repeat(2000);
    const started = performance.now();

    const run = buildProjection(
      input({ contentType: 'text/plain', body: text(longRun) }),
    );
    const keys = buildProjection(input({ body: text(manyKeys) }));
    const nested = buildProjection(input({ body: text(deep) }));
    const wide = buildProjection(
      input({
        contentType: 'text/plain',
        routingKey: 'r'.repeat(100_000),
        body: text('word '.repeat(12_000)),
      }),
    );

    expect(performance.now() - started).toBeLessThan(1500);
    expect(run.bodyText).toBe('[long] tail');
    expect(keys.bodyText?.length).toBeLessThanOrEqual(MAX_BODY_TEXT);
    expect(nested.bodyText?.length ?? 0).toBeLessThanOrEqual(MAX_BODY_TEXT);
    expect(wide.bodyText?.length).toBe(MAX_BODY_TEXT);
    expect(wide.metaText.length).toBeLessThanOrEqual(MAX_META_TEXT);
  });
});
