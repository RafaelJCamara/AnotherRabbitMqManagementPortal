// Admission: the checks every entry to the engine goes through, in one place so that a Fastify
// request and a WebSocket upgrade (which `ws` takes before Fastify, so no hook runs) are
// held to the same rules. Order: carrier, Host and Origin, Sec-Fetch, JSON-only, then credentials.
import type { IncomingHttpHeaders } from 'node:http';

import type { EngineMode } from '@app/contracts';
import type { Principal } from '@app/ports';

import { createHostPolicy } from '../guards/host-origin.ts';
import { checkJsonOnly } from '../guards/json-only.ts';
import { checkSecFetch } from '../guards/sec-fetch.ts';
import { httpError } from '../problem-handler.ts';
import {
  CARRIER_HEADER,
  parseBearer,
  type Authenticator,
} from './credentials.ts';

export interface TransportAuth {
  readonly mode: EngineMode;
  /** Tried in order; the first principal wins, none means 401. */
  readonly authenticators: readonly Authenticator[];
  /** Origins other than loopback this engine answers to (a reverse proxy, a published port). */
  readonly publicOrigins?: readonly string[];
}

export type Admission = ReturnType<typeof createAdmission>;

export function createAdmission(auth: TransportAuth) {
  const hosts = createHostPolicy(auth.publicOrigins ?? []);
  return {
    /** Throws a refusal (403, 400 or 415) unless the request may be looked at. */
    guard(
      headers: IncomingHttpHeaders,
      method: string,
      viaSocket: boolean,
      isPublic: boolean,
    ): void {
      // A socket is the network; only an injected request (the tunnel) is in-process.
      if (viaSocket && headers[CARRIER_HEADER] !== undefined) {
        throw httpError(403, 'The carrier header is not accepted here.');
      }
      hosts.check(headers, viaSocket);
      checkSecFetch(headers, isPublic);
      checkJsonOnly(headers, method);
    },
    /** The principal of the credentials, or undefined. A carrier request never falls back to a bearer token. */
    authenticate(headers: IncomingHttpHeaders): Principal | undefined {
      const carrier = headers[CARRIER_HEADER];
      const input = {
        bearer:
          carrier === undefined
            ? parseBearer(headers.authorization)
            : undefined,
        carrier: typeof carrier === 'string' ? carrier : undefined,
      };
      return auth.authenticators
        .map((authenticate) => authenticate(input))
        .find((candidate) => candidate !== undefined);
    },
  };
}
