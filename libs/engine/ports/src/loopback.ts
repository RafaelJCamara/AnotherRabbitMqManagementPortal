// What counts as loopback, in one place (M1-23, OQ-1462). A token endpoint may be plain `http` only
// when its issuer is on this machine (the lab). Two layers ask the same question and must not drift:
// the provider config (`svc-identity`) judges the NAME in the URL, and the token endpoint client
// (`adapter-token-endpoint`) judges the ADDRESS it is actually connected to. A name proves nothing
// about where a socket goes (`localhost` is whatever the resolver says), so the name check is only a
// first filter and the address check is the one that decides.
//
// Pure: no `net` import (I-9); the address forms are the ones Node reports for `socket.remoteAddress`.

const OCTET = '(0|[1-9][0-9]{0,2})';
const LOOPBACK_V4 = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

function isLoopbackV4(text: string): boolean {
  const match = LOOPBACK_V4.exec(text);
  if (match === null) return false;
  return [match[1], match[2], match[3]].every((part) => Number(part) <= 255);
}

/**
 * Whether the host part of a URL (`URL.hostname`, so already lowercased, with IPv4 shorthand
 * normalised and an IPv6 literal in brackets) names the loopback interface: exactly `localhost`,
 * `[::1]`, or a dotted address in 127.0.0.0/8. Anything else is false, including a name that merely
 * starts or ends like one (`127.0.0.1.evil.test`, `evil.localhost`) and IPv4-mapped IPv6 literals.
 */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '[::1]' || isLoopbackV4(hostname)
  );
}

/**
 * Whether a connected socket's peer (`socket.remoteAddress`) is on the loopback interface: an
 * address in 127.0.0.0/8, `::1`, or the IPv4-mapped form of one (`::ffff:127.0.0.1`). `undefined`
 * (a socket that is already gone) and every form this does not recognise are false: fail closed.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  if (isLoopbackV4(address)) return true;
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(.+)$/i.exec(address);
  return mapped?.[1] !== undefined && isLoopbackV4(mapped[1]);
}
