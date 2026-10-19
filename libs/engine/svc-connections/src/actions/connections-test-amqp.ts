// connections.test-amqp: Test the AMQP endpoint of a saved or unsaved profile, on its own
import { connectionsTestAmqp } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { ConnectionsModuleDeps } from '../deps';
import {
  SECRET_UNAVAILABLE,
  amqpEndpointOf,
  amqpFailure,
  amqpGates,
  loadSubject,
  probeSignal,
  runAmqpProbe,
} from '../internal/probe';

/** The ports this action uses: a subset of the module's deps (src/deps.ts). */
export type ConnectionsTestAmqpDeps = Pick<
  ConnectionsModuleDeps,
  'store' | 'sealer' | 'prober'
>;

export const createConnectionsTestAmqpAction = (
  deps: ConnectionsTestAmqpDeps,
): ActionImpl<typeof connectionsTestAmqp> =>
  implementAction(connectionsTestAmqp, {
    execute: async (input, ctx) => {
      const started = ctx.now();
      const subject = await loadSubject(deps, ctx.principal.id, input);
      const { amqp } = subject.config;
      const target = {
        host: amqp.host,
        port: amqp.port,
        tls: amqp.tls,
        vhost: amqp.vhost,
      };
      const missing = subject.missing.amqp;
      if (missing !== undefined) {
        const message = SECRET_UNAVAILABLE[missing];
        return {
          ok: false,
          target,
          tookMs: 0,
          failure: { code: 'SECRET_UNAVAILABLE' as const, message },
          gates: amqpGates(message),
        };
      }
      const result = await runAmqpProbe(
        deps.prober,
        amqpEndpointOf(subject),
        probeSignal(ctx.signal),
      );
      const tookMs = Math.max(0, ctx.now() - started);
      if (!result.ok) {
        const failure = amqpFailure(result.failure.reason, target);
        // The AMQP features close with the reason the person just read; HTTP features are not touched.
        return {
          ok: false,
          target,
          tookMs,
          failure,
          gates: amqpGates(failure.message),
        };
      }
      return { ok: true, target, tookMs, gates: amqpGates(undefined) };
    },
  });
