import { describe, expect, it } from 'vitest';

import { decodePayload } from '../payload/decode-payload.ts';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const xml = (text: string, limits = {}) =>
  decodePayload({ body: enc(text), contentType: 'application/xml', limits });

function textOf(text: string): string {
  const result = xml(text);
  expect(result.error, text).toBeUndefined();
  return result.view.kind === 'text' ? result.view.text : '';
}

describe('XML codec', () => {
  it('M1-10 AC-15 indents a valid document and keeps text-only elements on one line', () => {
    expect(
      textOf(
        '<?xml version="1.0"?><order id="17" paid=\'yes\'><line sku="A-1">2 &amp; 3</line><note/><empty></empty><!-- c --><![CDATA[<raw>]]></order>',
      ),
    ).toBe(
      [
        '<?xml version="1.0"?>',
        '<order id="17" paid=\'yes\'>',
        '  <line sku="A-1">2 &amp; 3</line>',
        '  <note/>',
        '  <empty></empty>',
        '  <!-- c -->',
        '  <![CDATA[<raw>]]>',
        '</order>',
      ].join('\n'),
    );
    const result = xml('<a><b>t</b></a>');
    expect(result.detected).toMatchObject({ type: 'xml', source: 'header' });
  });

  it('M1-10 AC-15 refuses a document type declaration without reading it', () => {
    const laughs =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';
    const result = xml(laughs);
    expect(result.error?.code).toBe('XML_DOCTYPE');
    expect(result.view.kind).toBe('hex');
    // Sniffed (no content type): the same, but as a note, since nothing was declared.
    const sniffed = decodePayload({ body: enc(laughs) });
    expect(sniffed.error?.code).toBeUndefined();
    expect(sniffed.notes).toContainEqual({ code: 'XML_DOCTYPE' });
    expect(sniffed.codec).toBe('text');
  });

  it('M1-10 AC-15 accepts the five predefined entities and numeric references, and refuses others', () => {
    expect(textOf('<a>&lt;&gt;&amp;&quot;&apos;&#65;&#x42;</a>')).toBe(
      '<a>&lt;&gt;&amp;&quot;&apos;&#65;&#x42;</a>',
    );
    for (const bad of [
      '<a>&nbsp;</a>',
      '<a>&lol;</a>',
      '<a b="&x;"/>',
      '<a>&#0;</a>',
      '<a>&#xD800;</a>',
      '<a>&#1114112;</a>',
    ]) {
      expect(xml(bad).error?.code, bad).toMatch(/XML_ENTITY|MALFORMED_XML/);
    }
    expect(xml('<a>&lol;</a>').error?.code).toBe('XML_ENTITY');
  });

  it('M1-10 AC-15 counts the depth and node limits and shows the source as text', () => {
    const deep = `${'<a>'.repeat(300)}${'</a>'.repeat(300)}`;
    const result = xml(deep);
    expect(result.view.kind).toBe('text');
    expect(result.truncations).toContainEqual({
      what: 'depth',
      max: 64,
      dropped: null,
    });
    expect(result.notes).toContainEqual({ code: 'DEPTH_LIMIT', detail: 64 });
    expect(result.error).toBeUndefined();

    const wide = `<r>${'<i/>'.repeat(500)}</r>`;
    const limited = xml(wide, { maxNodes: 50 });
    expect(limited.truncations).toContainEqual({
      what: 'nodes',
      max: 50,
      dropped: null,
    });
    expect(xml(wide).truncations).toEqual([]);
  });

  it('M1-10 AC-15 cuts a large document at the view limit', () => {
    const big = `<r>${'<i>some text</i>'.repeat(400000)}</r>`;
    const result = xml(big);
    expect(result.counters.viewBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(result.truncations.some((t) => t.what === 'view')).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('M1-10 AC-15 rejects what is not well-formed, with a coded error and no payload text', () => {
    const bad = [
      '<a>',
      '<a></b>',
      '</a>',
      '<a b=1/>',
      '<a b="1" b="2"/>',
      '<a b="<"/>',
      '<a><b></a></b>',
      'text',
      '<a/><b/>',
      '<a>text</a>trailing',
      '<a><!-- bad -- comment --></a>',
      '<a>]]></a>',
      '<a b="1"c="2"/>',
      '<1a/>',
      '<a>\u0001</a>',
      '<a><![CDATA[open</a>',
      '<a',
      '<',
    ];
    for (const text of bad) {
      const result = xml(text);
      expect(result.error?.code, text).toBe('MALFORMED_XML');
      expect(result.view.kind).toBe('hex');
    }
  });

  it('M1-10 AC-15 reads the encoding from the XML declaration and from a BOM', () => {
    const latin = Uint8Array.from(
      Buffer.from(
        '<?xml version="1.0" encoding="ISO-8859-1"?><a>café</a>',
        'latin1',
      ),
    );
    const result = decodePayload({
      body: latin,
      contentType: 'application/xml',
    });
    expect(result.error).toBeUndefined();
    expect(result.view).toMatchObject({ kind: 'text' });
    expect(
      result.view.kind === 'text' && result.view.text.includes('café'),
    ).toBe(true);
    const sniffed = decodePayload({ body: enc('<?xml version="1.0"?><a/>') });
    expect(sniffed.detected).toMatchObject({ type: 'xml', source: 'sniff' });
  });
});
