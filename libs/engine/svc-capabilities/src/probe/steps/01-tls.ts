// Step 1, TLS: the handshake on the management endpoint and what the certificate says. The socket is
// the wire probe's (Dialer and TrustStore, I-9); the step only records the outcome. A failed or
// missing check is never `verified`.
import type { ProbeStep } from '../types';

export const tlsStep: ProbeStep = {
  id: 'tls',
  async run(env, facts) {
    const result = await env.wire.tls(env.connectionId, env.signal);
    facts.tls = result;
    if (result.kind === 'failed') {
      return { status: 'failed', detail: result.failure.reason };
    }
    if (result.kind === 'plain') {
      return { status: 'skipped', detail: 'the endpoint is plain HTTP' };
    }
    return {
      status: 'ok',
      detail: result.verified
        ? 'the certificate chain verified'
        : result.insecureOverride
          ? 'verification is switched off for this connection'
          : 'the certificate chain did not verify',
    };
  },
};
