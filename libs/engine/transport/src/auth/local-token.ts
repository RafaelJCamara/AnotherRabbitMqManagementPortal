// Local web mode (blueprint 7.2): the launch token is the engine's own 256-bit secret, sent as a
// Bearer token. It is never accepted in a URL, a cookie or a body, so it cannot reach a log line,
// a referrer or the browser history.
import type { Principal } from '@app/ports';

import {
  assertSecret,
  sameSecret,
  type Authenticator,
  type AuthInput,
} from './credentials.ts';

const localUser = (): Principal => ({
  kind: 'local-token',
  id: 'local-token',
  display: 'Local session',
  roles: [],
  surface: 'ui',
  unattended: false,
});

/** Authenticates the launch token. A request that carries a carrier header never reaches it. */
export function createLocalTokenAuth(token: string): Authenticator {
  assertSecret('The launch token', token);
  return (input: AuthInput) =>
    input.carrier === undefined &&
    input.bearer !== undefined &&
    sameSecret(input.bearer, token)
      ? localUser()
      : undefined;
}
