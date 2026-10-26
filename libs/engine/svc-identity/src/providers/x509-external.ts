// The x509/EXTERNAL provider: the login is the client certificate, so there is no secret to hand
// over. It serves AMQP only; the management API has no certificate login (OQ-1461). Presenting the
// certificate needs the trust store to learn client certificates, which is a follow-up.
import { AppError } from '@app/kernel';

import type { CredentialProvider } from '../provider';

export function createX509ExternalProvider(): CredentialProvider {
  return {
    kind: 'x509-external',
    acquire({ protocol }) {
      if (protocol !== 'amqp') {
        return Promise.reject(
          new AppError('VALIDATION_FAILED', {
            detail:
              'A client certificate login works for AMQP only: the management API has no certificate login.',
          }),
        );
      }
      return Promise.resolve({ kind: 'external' });
    },
  };
}
