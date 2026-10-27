import {
  ConnectionIdSchema,
  MessagesPublishInputSchema,
  PUBLISH_LIMITS,
} from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { emptyDraft, type PublishDraft } from './draft';
import { draftToInput } from './draft-to-input';
import { newRow } from './header-model';

const cid = ConnectionIdSchema.parse('c1');

const draftWith = (patch: Partial<PublishDraft>): PublishDraft => ({
  ...emptyDraft(),
  ...patch,
});

const fields = (draft: PublishDraft): string[] => {
  const result = draftToInput(cid, draft);
  if (result.ok) throw new Error('expected the draft to be refused');
  return result.issues.map((issue) => issue.field).sort();
};

describe('draftToInput', () => {
  it('M1-46 AC-20 builds the exact publish input from the draft', () => {
    const utf8 = draftToInput(
      cid,
      draftWith({
        vhost: 'shop',
        exchange: '',
        routingKey: 'orders.q',
        props: {
          contentType: 'application/json',
          deliveryMode: 2,
          priority: 5,
          timestamp: 1_700_000_000,
          correlationId: '',
          replyTo: 'reply.q',
        },
        headers: [
          newRow('attempt', 'long', '3'),
          newRow('ratio', 'double', '1.5'),
          newRow('urgent', 'bool', 'true'),
          newRow('blob', 'bytes', 'aGk='),
        ],
        body: { encoding: 'utf8', data: '{"a":1}', language: 'json' },
        copies: 3,
        timeoutMs: 1_500,
      }),
    );
    expect(utf8).toEqual({
      ok: true,
      input: {
        cid: 'c1',
        vhost: 'shop',
        exchange: '',
        routingKey: 'orders.q',
        props: {
          contentType: 'application/json',
          deliveryMode: 2,
          priority: 5,
          timestamp: 1_700_000_000,
          replyTo: 'reply.q',
        },
        headers: {
          attempt: { t: 'long', v: 3 },
          ratio: { t: 'double', v: 1.5 },
          urgent: { t: 'bool', v: true },
          blob: { t: 'bytes', v: 'aGk=' },
        },
        body: { encoding: 'utf8', data: '{"a":1}' },
        copies: 3,
        mandatory: true,
        confirm: true,
        timeoutMs: 1_500,
      },
    });
    if (!utf8.ok) throw new Error('unreachable');
    expect(MessagesPublishInputSchema.safeParse(utf8.input).success).toBe(true);

    const base64 = draftToInput(
      cid,
      draftWith({
        exchange: 'orders.x',
        body: { encoding: 'base64', data: 'aGVsbG8=', language: 'plaintext' },
      }),
    );
    expect(base64).toMatchObject({
      ok: true,
      input: {
        exchange: 'orders.x',
        body: { encoding: 'base64', data: 'aGVsbG8=' },
        copies: 1,
        timeoutMs: PUBLISH_LIMITS.timeoutMsDefault,
        mandatory: true,
        confirm: true,
      },
    });
    // No header rows: the key is absent, not an empty table.
    expect(base64.ok && 'headers' in base64.input).toBe(false);
  });

  it('M1-46 AC-21 mirrors the publish limits before any call', () => {
    const tooManyHeaders = Array.from({ length: 65 }, (_, i) =>
      newRow(`h${String(i)}`, 'string', 'x'),
    );
    let nest = '[]';
    for (let level = 0; level < 8; level++) {
      nest = `[{"value":{"t":"array","v":${nest}}}]`;
    }
    const cases: [string, Partial<PublishDraft>, string, object][] = [
      ['copies', { copies: 101 }, 'copies', { min: 1, limit: 100 }],
      [
        'body',
        {
          body: {
            encoding: 'utf8',
            data: 'x'.repeat(1_048_577),
            language: 'plaintext',
          },
        },
        'body',
        { code: 'over-limit', limit: 1_048_576 },
      ],
      [
        'headers',
        { headers: tooManyHeaders },
        'headers',
        { code: 'too-many', limit: 64 },
      ],
      [
        'nesting',
        { headers: [newRow('deep', 'array', nest)] },
        'headers.',
        { code: 'too-deep', limit: 8, name: 'deep' },
      ],
      [
        'prop',
        { props: { appId: 'x'.repeat(256) } },
        'props.appId',
        { code: 'too-long', limit: 255 },
      ],
      ['timeout', { timeoutMs: 99 }, 'timeoutMs', { min: 100, limit: 30_000 }],
      [
        'base64',
        {
          body: {
            encoding: 'base64',
            data: 'not base64!',
            language: 'plaintext',
          },
        },
        'body',
        { code: 'invalid-base64' },
      ],
    ];
    for (const [label, patch, field, extra] of cases) {
      const result = draftToInput(cid, draftWith(patch));
      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      const issue = result.issues.find((i) =>
        field.endsWith('.') ? i.field.startsWith(field) : i.field === field,
      );
      expect(issue, label).toMatchObject({ ...extra });
      expect(result.issues, label).toHaveLength(1);
    }
    // A body of exactly 1 MiB, and 64 headers, 100 copies, 255 characters and 30 s are within the limits.
    const edge = draftWith({
      copies: 100,
      timeoutMs: 30_000,
      props: { appId: 'x'.repeat(255) },
      headers: tooManyHeaders.slice(0, 64),
      body: {
        encoding: 'utf8',
        data: 'x'.repeat(1_048_576),
        language: 'plaintext',
      },
    });
    expect(draftToInput(cid, edge).ok).toBe(true);
    // The size is the encoded one: 3-byte characters count three times.
    expect(
      fields(
        draftWith({
          body: {
            encoding: 'utf8',
            data: '€'.repeat(349_526),
            language: 'plaintext',
          },
        }),
      ),
    ).toEqual(['body']);
  });

  it('names every field that is wrong, each once, and sends nothing', () => {
    expect(
      fields(
        draftWith({
          vhost: '',
          exchange: 'e'.repeat(256),
          routingKey: 'k'.repeat(256),
          copies: 0,
          timeoutMs: 30_001,
          props: { priority: 256, timestamp: -1, contentType: 'c'.repeat(256) },
        }),
      ),
    ).toEqual([
      'copies',
      'exchange',
      'props.contentType',
      'props.priority',
      'props.timestamp',
      'routingKey',
      'timeoutMs',
      'vhost',
    ]);
    expect(fields(draftWith({ vhost: 'v'.repeat(256) }))).toEqual(['vhost']);
    // 255 characters are within the bound of each text field.
    const edgeText = 'x'.repeat(255);
    expect(
      draftToInput(
        cid,
        draftWith({
          vhost: edgeText,
          exchange: edgeText,
          routingKey: edgeText,
        }),
      ).ok,
    ).toBe(true);
    const range = draftToInput(
      cid,
      draftWith({ props: { priority: 256, timestamp: -1 } }),
    );
    expect(range.ok ? [] : range.issues).toEqual([
      { field: 'props.priority', code: 'out-of-range', min: 0, limit: 255 },
      {
        field: 'props.timestamp',
        code: 'out-of-range',
        min: 0,
        limit: Number.MAX_SAFE_INTEGER,
      },
    ]);
    expect(fields(draftWith({ copies: 1.5 }))).toEqual(['copies']);
    expect(fields(draftWith({ copies: Number.NaN }))).toEqual(['copies']);
    expect(fields(draftWith({ props: { priority: 1.5 } }))).toEqual([
      'props.priority',
    ]);
    // Zero and the largest priority are valid.
    expect(draftToInput(cid, draftWith({ props: { priority: 0 } })).ok).toBe(
      true,
    );
    expect(
      draftToInput(cid, draftWith({ props: { priority: 255, timestamp: 0 } }))
        .ok,
    ).toBe(true);
  });

  it('blocks while the headers JSON is not a typed table, and only then', () => {
    const base = { headerJsonError: 'json' as const };
    expect(fields(draftWith({ ...base, headerMode: 'json' }))).toEqual([
      'headers',
    ]);
    expect(
      fields(draftWith({ headerJsonError: 'shape', headerMode: 'json' })),
    ).toEqual(['headers']);
    // The table mode, or a JSON that is fine, never carries the error.
    expect(
      draftToInput(cid, draftWith({ ...base, headerMode: 'grid' })).ok,
    ).toBe(true);
    expect(
      draftToInput(
        cid,
        draftWith({ headerJsonError: null, headerMode: 'json' }),
      ).ok,
    ).toBe(true);
  });

  it('keeps the header problems on their rows', () => {
    const rows = [
      newRow('a', 'long', 'x'),
      newRow('a', 'string', 'y'),
      newRow('', 'string', ''),
    ];
    const result = draftToInput(cid, draftWith({ headers: rows }));
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.issues).toEqual([
      { field: `headers.${rows[0]?.id ?? ''}`, code: 'bad-value', name: 'a' },
      { field: `headers.${rows[1]?.id ?? ''}`, code: 'duplicate', name: 'a' },
      {
        field: `headers.${rows[2]?.id ?? ''}`,
        code: 'name-required',
        name: '',
      },
    ]);
  });

  it('falls back to a form-level issue when the contract still refuses', () => {
    // The checks above cover every field of the draft; what is left is the connection id.
    expect(draftToInput('' as typeof cid, emptyDraft())).toEqual({
      ok: false,
      issues: [{ field: 'form', code: 'invalid' }],
    });
  });

  it('sends only the properties it knows, and none that is empty', () => {
    const result = draftToInput(
      cid,
      draftWith({ props: { type: '', appId: 'a', nope: 'x' } as never }),
    );
    expect(result.ok && result.input.props).toEqual({ appId: 'a' });
  });
});
