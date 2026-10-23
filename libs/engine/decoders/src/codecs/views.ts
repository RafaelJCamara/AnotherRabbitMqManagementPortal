// Hex and base64 views of bytes, and the text the pipeline shows for them. A view shows a prefix
// of at most `max` bytes; the caller counts what is left out (I-6, I-13).
const HEX = '0123456789abcdef';

/** A classic dump: offset, 16 bytes in hex, and an ASCII gutter. */
export function hexDump(bytes: Uint8Array, max: number): string {
  const shown = Math.min(bytes.length, max);
  const lines: string[] = [];
  for (let row = 0; row < shown; row += 16) {
    const end = Math.min(row + 16, shown);
    let hex = '';
    let ascii = '';
    for (let i = row; i < row + 16; i++) {
      if (i < end) {
        const byte = bytes[i] ?? 0;
        hex += `${HEX[byte >> 4] ?? '0'}${HEX[byte & 15] ?? '0'} `;
        ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
      } else {
        hex += '   ';
      }
      if (i === row + 7) hex += ' ';
    }
    lines.push(`${row.toString(16).padStart(8, '0')}  ${hex} |${ascii}|`);
  }
  return lines.join('\n');
}

/** Base64 of a prefix, wrapped at 76 characters. */
export function base64View(bytes: Uint8Array, max: number): string {
  const shown = bytes.subarray(0, Math.min(bytes.length, max));
  const flat = Buffer.from(
    shown.buffer,
    shown.byteOffset,
    shown.length,
  ).toString('base64');
  const lines: string[] = [];
  for (let at = 0; at < flat.length; at += 76)
    lines.push(flat.slice(at, at + 76));
  return lines.join('\n');
}

/** The text cut so that its UTF-8 form fits `max` bytes, at a character boundary. */
export function fitUtf8(
  text: string,
  max: number,
): { text: string; cutChars: number } {
  if (text.length * 3 <= max || Buffer.byteLength(text, 'utf8') <= max) {
    return { text, cutChars: 0 };
  }
  const encoded = Buffer.from(text, 'utf8');
  let use = max;
  while (use > 0 && ((encoded[use] ?? 0) & 0xc0) === 0x80) use--;
  const kept = encoded.subarray(0, use).toString('utf8');
  return { text: kept, cutChars: text.length - kept.length };
}

export function isPrintableUtf8Sample(sample: Uint8Array): boolean {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(sample, {
      stream: true,
    });
  } catch {
    return false;
  }
  if (decoded.length === 0) return false;
  let control = 0;
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) control++;
    if (code === 0) return false;
  }
  return control * 50 <= decoded.length;
}
