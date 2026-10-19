// Step 2, host fingerprint: the provider a host name points to (`*.mq.<region>.amazonaws.com`,
// `*.rmq*.cloudamqp.com`, ...), from the registry's presets. No request is made.
import { providerOfHost } from '../providers';
import type { ProbeStep } from '../types';

export const hostFingerprintStep: ProbeStep = {
  id: 'host-fingerprint',
  async run(env, facts) {
    const target = await env.wire.describe(env.connectionId, env.signal);
    if (target === undefined) {
      return {
        status: 'unavailable',
        detail: 'the connection has no endpoint',
      };
    }
    facts.target = target;
    const provider = providerOfHost(env.registry, target.host);
    if (provider === undefined) {
      return {
        status: 'ok',
        detail: 'the host name matches no known provider',
      };
    }
    return { status: 'ok', detail: `the host name says ${provider}` };
  },
};
