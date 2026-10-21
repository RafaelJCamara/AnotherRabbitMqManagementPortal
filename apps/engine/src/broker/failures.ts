// What a failed dial, handshake or request means to a person: the stable tokens of `ProbeFailure`
// (`@app/ports`). Neither mapping repeats the text of an error, which may hold an address or a
// banner; the token is all that leaves this file (I-10).
import { Amqp091Error } from '@app/adapter-amqp091';
import { MgmtHttpError } from '@app/adapter-mgmt-http';
import { NetworkError } from '@app/net-truststore';
import type { ProbeFailure } from '@app/ports';

/** A failure of the management HTTP request of a probe. */
export function httpFailure(error: unknown): ProbeFailure {
  if (error instanceof NetworkError || error instanceof MgmtHttpError) {
    if (error.code === 'EGRESS_DENIED') return { reason: 'egress-denied' };
    if (error.code === 'TLS_UNTRUSTED') return { reason: 'tls-untrusted' };
  }
  if (error instanceof MgmtHttpError) {
    switch (error.reason) {
      case 'auth-refused':
      case 'token-expired':
        return { reason: 'auth-refused' };
      case 'missing-tag':
        return { reason: 'missing-tag' };
      case 'connect-failed':
        return { reason: 'unreachable' };
      case 'timeout':
        return { reason: 'timeout' };
      // The socket connected and then the HTTP exchange broke (an AMQP port answering with its own
      // protocol header, a reset): something is there, and it is not a management API.
      case 'network':
      case 'unexpected-body':
      case 'not-found':
      case 'unexpected-status':
      case 'redirect-refused':
        return { reason: 'not-management' };
      default:
        return { reason: 'unexpected' };
    }
  }
  return { reason: 'unexpected' };
}

/** A failure of an AMQP connection attempt, or of a bare dial. */
export function amqpFailure(error: unknown): ProbeFailure {
  if (error instanceof NetworkError) {
    if (error.code === 'EGRESS_DENIED') return { reason: 'egress-denied' };
    if (error.code === 'TLS_UNTRUSTED') return { reason: 'tls-untrusted' };
    return { reason: 'unreachable' };
  }
  if (error instanceof Amqp091Error) {
    if (error.reason === 'auth-refused') return { reason: 'auth-refused' };
    if (error.reason === 'tls-untrusted') return { reason: 'tls-untrusted' };
    if (error.reason === 'timeout') return { reason: 'timeout' };
    if (error.reason === 'connect-failed') return { reason: 'unreachable' };
    // RabbitMQ answers connection.open with a close (530, not-allowed) for a vhost the user may not
    // use or that does not exist, after the login was accepted. amqplib reports it only as `Expected
    // ConnectionOpenOk; got <ConnectionClose>` in the cause (OQ-441 recommends the adapter map it),
    // so it is read from there, and the cause's text is never passed on.
    const cause = error.cause instanceof Error ? error.cause.message : '';
    if (
      error.broker?.code === 530 ||
      cause.includes('ConnectionOpenOk; got <ConnectionClose')
    ) {
      return { reason: 'vhost-refused' };
    }
  }
  return { reason: 'unexpected' };
}
