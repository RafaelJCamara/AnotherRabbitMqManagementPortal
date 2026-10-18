// DNS rebinding and cross-site guards (blueprint 7.2, threat T1): the Host header must name this
// engine, and an Origin, when present, must be this engine's own origin. Loopback names are accepted
// on any port, so a remapped container port works (blueprint 1.2); anything else must be listed
// as a public origin. Names are matched exactly, never by suffix.
import type { IncomingHttpHeaders } from 'node:http';

import { httpError } from '../problem-handler.ts';

const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/;

/** The Host an injected request carries (the tunnel sets it); a socket request never may. */
export const INTERNAL_HOST = 'engine.internal';

export interface HostPolicy {
  /** Throws a 403 unless Host (and Origin, when sent) belong to this engine. */
  check(headers: IncomingHttpHeaders, viaSocket: boolean): void;
}

function isLoopback(host: string): boolean {
  const port = LOOPBACK.exec(host)?.[1];
  return LOOPBACK.test(host) && (port === undefined || Number(port) <= 65535);
}

/** `publicOrigins` are `https://host[:port]` (or http) origins of a reverse proxy or a published port. */
export function createHostPolicy(publicOrigins: readonly string[]): HostPolicy {
  const byHost = new Map<string, string>();
  for (const text of publicOrigins) {
    const url = new URL(text);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== text.toLowerCase() ||
      url.host === ''
    ) {
      throw new TypeError(`Not a plain origin: ${url.protocol}//${url.host}`);
    }
    byHost.set(url.host, url.origin);
  }
  return {
    check(headers, viaSocket) {
      const { host, origin } = headers;
      if (typeof host !== 'string')
        throw httpError(403, 'Host is not allowed.');
      const name = host.toLowerCase();
      if (
        !isLoopback(name) &&
        !byHost.has(name) &&
        !(name === INTERNAL_HOST && !viaSocket)
      ) {
        throw httpError(403, 'Host is not allowed.');
      }
      if (origin === undefined) return;
      // Same origin only: the Origin must be this Host spelled as an origin.
      const own = byHost.get(name) ?? `http://${name}`;
      if (typeof origin !== 'string' || origin.toLowerCase() !== own) {
        throw httpError(403, 'Origin is not allowed.');
      }
    },
  };
}
