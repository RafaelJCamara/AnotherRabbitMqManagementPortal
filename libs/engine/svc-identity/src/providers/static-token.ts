// The static-token provider: a token the person pasted, stored sealed with the profile. It is never
// refreshed here (OQ-1456): its `exp` is read so the TokenManager can report when it ends, and a
// token that cannot be read, or has no `exp`, is refused rather than used blind.
import { AppError, type Clock } from '@app/kernel';
import type { StoredLoginPort } from '@app/ports';

import { bearerCredential } from '../internal/bearer';
import { DEFAULT_USERNAME_CLAIMS } from '../internal/claims';
import type { CredentialProvider } from '../provider';

export function createStaticTokenProvider(deps: {
  readonly stored: StoredLoginPort;
  readonly clock: Clock;
  readonly usernameClaims?: readonly string[];
}): CredentialProvider {
  return {
    kind: 'static-token',
    async acquire({ connectionId, protocol }) {
      let login: Awaited<ReturnType<StoredLoginPort['open']>>;
      try {
        login = await deps.stored.open(connectionId, protocol);
      } catch {
        // No `cause`: what the vault or the store said stays out of the error (I-10).
        throw new AppError('INTERNAL', {
          detail: 'The stored credential could not be read.',
        });
      }
      if (login.kind === 'locked') {
        throw new AppError('GATE_BLOCKED', {
          detail:
            'The stored token cannot be opened: the credential vault is locked, or the credential was stored under another key.',
        });
      }
      if (login.kind === 'absent') {
        throw new AppError('NOT_FOUND', {
          detail: 'No token is stored for this connection and protocol.',
        });
      }
      return bearerCredential({
        token: login.secret,
        usernameClaims: deps.usernameClaims ?? DEFAULT_USERNAME_CLAIMS,
        clock: deps.clock,
        requireExpiry: true,
      });
    },
  };
}
