import { describe, expect, it } from 'vitest';

import { MAX_SCRUB_STRING, scrubJson, scrubText } from './scrub.ts';

describe('scrub: data that is stored for good (I-10, I-5)', () => {
  it('redacts first and clips after, so a clip never leaves half a secret behind', () => {
    const text = `amqp://admin:${'p'.repeat(400)}@broker.example/vhost`;

    const out = scrubText(text, 40);

    expect(out).toBe('amqp://[REDACTED]@broker.example/vhost');
    expect(out).not.toContain('pppp');
  });

  it('clips what is left after redaction', () => {
    expect(scrubText('a'.repeat(300), 100)).toBe(
      `${'a'.repeat(100)}...[clipped]`,
    );
  });

  it('replaces a string too long to scrub with a marker, whatever it holds', () => {
    const hostile = `amqp://u:secret${'x'.repeat(MAX_SCRUB_STRING)}@h`;

    expect(scrubText(hostile, 256)).toBe(
      `[too long: ${String(hostile.length)} characters]`,
    );
  });

  it('does not stall on one long unbroken run (the case that is quadratic for the patterns)', () => {
    const started = performance.now();

    scrubText('x'.repeat(5_000_000), 256);
    scrubJson({ a: 'eyJ'.repeat(1_000_000), b: ['x'.repeat(3_000_000)] });

    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('masks sensitive keys, scrubs nested strings and clips the rest', () => {
    const out = scrubJson(
      {
        password: 'hunter2',
        nested: [{ token: 't' }, 'Bearer abcdefghijklmnop'],
        ok: 'fine',
        long: 'z'.repeat(500),
      },
      50,
    );

    expect(out).toEqual({
      password: '[REDACTED]',
      nested: [{ token: '[REDACTED]' }, 'Bearer [REDACTED]'],
      ok: 'fine',
      long: `${'z'.repeat(50)}...[clipped]`,
    });
  });

  it('bounds the depth and the length of keys', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i += 1) deep = { next: deep };

    const text = JSON.stringify(scrubJson({ ['k'.repeat(1_000)]: 1, deep }));

    expect(text).toContain('[too deep]');
    expect(text).not.toContain('k'.repeat(300));
  });
});
