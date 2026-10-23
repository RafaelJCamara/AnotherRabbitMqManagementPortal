import { describe, expect, it } from 'vitest';

import { CODEC_MESSAGES } from '../codecs/errors.ts';
import { DEFAULT_LIMITS, tightenLimits } from '../codecs/limits.ts';
import { decodePayload, encodePayload } from './decode-payload.ts';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('decodePayload', () => {
  it('M1-10 AC-1 gives hex and an inline error with the offset for a malformed payload', () => {
    const body = enc('{"order":{"id":17,"lines":[{"sku":"A-1","qty":2},');
    const result = decodePayload({ body, contentType: 'application/json' });
    expect(result.codec).toBe('raw');
    expect(result.view.kind).toBe('hex');
    if (result.view.kind !== 'hex') return;
    expect(result.view.totalBytes).toBe(body.length);
    expect(result.view.text.startsWith('00000000  7b 22 6f 72 64 65 72')).toBe(
      true,
    );
    expect(result.error).toEqual({
      code: 'MALFORMED_JSON',
      message: CODEC_MESSAGES.MALFORMED_JSON,
      offset: body.length,
    });
    // The message is a fixed phrase: it carries no byte of the payload (I-10).
    expect(result.error?.message).not.toContain('order');
    // What the sender declared is still reported, with no confidence in it.
    expect(result.detected).toMatchObject({
      type: 'json',
      confidence: 0,
      source: 'header',
    });
  });

  it('M1-10 AC-1 reports the counters and the layers of a plain document', () => {
    const body = enc('{"a":1}');
    const result = decodePayload({ body });
    expect(result.counters).toEqual({
      inputBytes: 7,
      decodedBytes: 7,
      viewBytes: result.counters.viewBytes,
    });
    expect(result.counters.viewBytes).toBeGreaterThan(0);
    expect(result.layers).toEqual([]);
  });

  it('M1-10 AC-8 treats an empty body as empty, not as an error', () => {
    const result = decodePayload({
      body: new Uint8Array(0),
      contentEncoding: 'base64',
      contentType: 'application/json',
    });
    expect(result.error).toBeUndefined();
    expect(result.detected.type).toBe('empty');
    expect(result.counters).toEqual({
      inputBytes: 0,
      decodedBytes: 0,
      viewBytes: 0,
    });
  });

  it('M1-10 AC-8 shows a body above the input limit as a hex prefix and says so', () => {
    const result = decodePayload({
      body: new Uint8Array(5000),
      limits: { maxInputBytes: 1000, previewBytes: 64 },
    });
    expect(result.error?.code).toBe('INPUT_LIMIT');
    expect(result.view).toMatchObject({
      kind: 'hex',
      shownBytes: 64,
      totalBytes: 5000,
    });
    expect(result.truncations).toEqual([
      { what: 'preview', max: 64, dropped: 4936 },
    ]);
  });

  it('M1-10 AC-8 surfaces a body the capture had already cut', () => {
    const result = decodePayload({
      body: enc('{"a":'),
      contentType: 'application/json',
      bodyTruncated: true,
    });
    expect(result.truncations).toContainEqual({
      what: 'source',
      max: 5,
      dropped: null,
    });
    expect(result.notes).toContainEqual({ code: 'SOURCE_TRUNCATED' });
    expect(result.error?.code).toBe('MALFORMED_JSON');
  });

  it('M1-10 AC-8 never throws on a hostile input object', () => {
    const hostile = [
      undefined,
      null,
      {},
      { body: 'not bytes' },
      { body: null },
      {
        body: new Uint8Array(3),
        contentType: { toString: 1 },
        rules: 'x',
        limits: 7,
      },
      {
        body: new Uint8Array(3),
        rules: [{ queue: 'q', codec: 'nope' }],
        queue: 'q',
      },
      {
        body: new Uint8Array(3),
        limits: { maxViewBytes: -1, maxDepth: Number.NaN, previewBytes: 1.5 },
      },
    ];
    for (const input of hostile) {
      const result = decodePayload(input as never);
      expect(result.view).toBeDefined();
      expect(Object.values(CODEC_MESSAGES)).toContain(
        result.error?.message ?? CODEC_MESSAGES.INTERNAL,
      );
    }
  });

  it('M1-10 AC-8 lets a caller tighten the limits and never loosen them', () => {
    expect(tightenLimits({ maxDepth: 5 }).maxDepth).toBe(5);
    expect(tightenLimits({ maxDepth: 5000 }).maxDepth).toBe(
      DEFAULT_LIMITS.maxDepth,
    );
    expect(tightenLimits({ maxDepth: -1 }).maxDepth).toBe(
      DEFAULT_LIMITS.maxDepth,
    );
    expect(tightenLimits({ maxNodes: 1.5 }).maxNodes).toBe(
      DEFAULT_LIMITS.maxNodes,
    );
    expect(tightenLimits('big')).toBe(DEFAULT_LIMITS);
    expect(Object.isFrozen(tightenLimits({}))).toBe(true);
  });

  it('M1-10 AC-9 encodes text and JSON, and refuses a codec that has no encoder', () => {
    expect(new TextDecoder().decode(encodePayload('text', 'héllo'))).toBe(
      'héllo',
    );
    expect(new TextDecoder().decode(encodePayload('json', { a: [1, 2] }))).toBe(
      '{"a":[1,2]}',
    );
    expect(new TextDecoder().decode(encodePayload('json', undefined))).toBe(
      'null',
    );
    expect(() => encodePayload('pickle', 1)).toThrow();
  });
});
