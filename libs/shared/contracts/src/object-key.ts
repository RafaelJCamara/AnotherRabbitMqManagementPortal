// ObjectKey = base64url(utf8(vhost) 0x00 utf8(name)). Broker objects travel in paths as one opaque
// segment, so the `/` vhost and names with `/` or unicode survive ingresses and proxies (ADR-003).
import { ObjectKeySchema, type ObjectKey } from './brands.ts';

const SEPARATOR = 0;
const encoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF in the text: by default the decoder drops it, and a name that
// starts with one would not round-trip.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function assertWellFormed(value: string, what: string): void {
  // TextEncoder would silently replace a lone surrogate, and the round trip would change the text.
  if (/\p{Surrogate}/u.test(value)) {
    throw new TypeError(`${what} is not well-formed unicode`);
  }
}

export function encodeObjectKey(vhost: string, name: string): ObjectKey {
  assertWellFormed(vhost, 'vhost');
  assertWellFormed(name, 'name');
  if (vhost.includes('\u0000')) {
    throw new TypeError('vhost must not contain NUL');
  }
  const head = encoder.encode(vhost);
  const tail = encoder.encode(name);
  const bytes = new Uint8Array(head.length + 1 + tail.length);
  bytes.set(head, 0);
  bytes[head.length] = SEPARATOR;
  bytes.set(tail, head.length + 1);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return ObjectKeySchema.parse(
    btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''),
  );
}

export function decodeObjectKey(key: ObjectKey): {
  vhost: string;
  name: string;
} {
  ObjectKeySchema.parse(key);
  const standard = key.replaceAll('-', '+').replaceAll('_', '/');
  let binary: string;
  try {
    binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='));
  } catch {
    throw new TypeError('ObjectKey is not valid base64url');
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const at = bytes.indexOf(SEPARATOR);
  if (at < 0) throw new TypeError('ObjectKey has no vhost/name separator');
  try {
    return {
      vhost: decoder.decode(bytes.subarray(0, at)),
      name: decoder.decode(bytes.subarray(at + 1)),
    };
  } catch {
    throw new TypeError('ObjectKey is not valid utf-8');
  }
}
