// Desktop mode (blueprint 3.3): the MessagePort tunnel (M0-34) injects requests and sets the
// per-boot carrier secret; this authenticator maps it to the desktop user. The secret never leaves
// engine memory, and `app.ts` refuses it on any request that arrived over a socket.
import type { Principal } from '@app/ports';

import {
  assertSecret,
  sameSecret,
  type Authenticator,
  type AuthInput,
} from './credentials.ts';

const desktopUser = (): Principal => ({
  kind: 'desktop-user',
  id: 'desktop-user',
  display: 'Desktop user',
  roles: [],
  surface: 'ui',
  unattended: false,
});

export function createCarrierAuth(secret: string): Authenticator {
  assertSecret('The carrier secret', secret);
  return (input: AuthInput) =>
    input.carrier !== undefined && sameSecret(input.carrier, secret)
      ? desktopUser()
      : undefined;
}
