// The password provider: the login stored with the profile, as it is today. It fails closed when
// the vault cannot open it; the text names neither the user nor any part of the secret (I-10).
import { AppError } from '@app/kernel';
import type { StoredLoginPort } from '@app/ports';

import { SecretValue } from '../internal/secret-value';
import type { CredentialProvider } from '../provider';

export function createPasswordProvider(deps: {
  readonly stored: StoredLoginPort;
}): CredentialProvider {
  return {
    kind: 'password',
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
            'The stored login cannot be opened: the credential vault is locked, or the credential was stored under another key.',
        });
      }
      if (login.kind === 'absent') {
        throw new AppError('NOT_FOUND', {
          detail: 'No login is stored for this connection and protocol.',
        });
      }
      if (login.username === null || login.username === '') {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'The stored login has no user name.',
        });
      }
      return {
        kind: 'password',
        username: login.username,
        password: new SecretValue(login.secret),
      };
    },
  };
}
