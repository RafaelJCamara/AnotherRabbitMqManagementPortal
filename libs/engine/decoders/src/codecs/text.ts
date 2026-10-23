// Plain text with a charset hint. The weakest sniff: it wins only when nothing else claims the
// bytes, and it decodes leniently (replacing invalid bytes and saying so).
import { decodeText, bomOf, utf16Pattern } from './charset.ts';
import type { CodecNote, FormatCodec, Truncation } from './types.ts';
import { isPrintableUtf8Sample } from './views.ts';

export const textCodec: FormatCodec = {
  kind: 'format',
  id: 'text',
  mimes: ['text/plain'],
  detect(sample) {
    const bom = bomOf(sample);
    if (bom !== undefined || utf16Pattern(sample) !== undefined) return 0.3;
    return isPrintableUtf8Sample(sample) ? 0.3 : 0;
  },
  decode(bytes, context) {
    const decoded = decodeText(bytes, {
      declared: context.charset,
      maxBytes: context.limits.maxViewBytes,
      lossy: true,
    });
    const truncations: Truncation[] =
      decoded.cutBytes > 0
        ? [
            {
              what: 'view',
              max: context.limits.maxViewBytes,
              dropped: decoded.cutBytes,
            },
          ]
        : [];
    const notes: CodecNote[] =
      decoded.replacements > 0
        ? [{ code: 'LOSSY_TEXT', detail: decoded.replacements }]
        : [];
    return {
      view: { kind: 'text', text: decoded.text, charset: decoded.charset },
      type: 'text',
      mime: 'text/plain',
      truncations,
      notes,
    };
  },
  encode(value) {
    return new TextEncoder().encode(typeof value === 'string' ? value : '');
  },
};
