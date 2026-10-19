// connections.test-http: Test the management HTTP endpoint of a saved or unsaved profile, on its own
import { PROBE_FACTS_MAX, connectionsTestHttp } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { ConnectionsModuleDeps } from '../deps';
import { managementUrl } from '../internal/endpoints';
import { amqpPortsFromListeners } from '../internal/listeners';
import {
  SECRET_UNAVAILABLE,
  httpEndpointOf,
  httpFailure,
  loadSubject,
  probeSignal,
  runHttpProbe,
} from '../internal/probe';

/** The ports this action uses: a subset of the module's deps (src/deps.ts). */
export type ConnectionsTestHttpDeps = Pick<
  ConnectionsModuleDeps,
  'store' | 'sealer' | 'prober'
>;

/** The broker's own words are bounded before they are shown (I-6). */
const clip = (text: string | undefined): string | undefined =>
  text?.slice(0, 200);

export const createConnectionsTestHttpAction = (
  deps: ConnectionsTestHttpDeps,
): ActionImpl<typeof connectionsTestHttp> =>
  implementAction(connectionsTestHttp, {
    execute: async (input, ctx) => {
      const started = ctx.now();
      const subject = await loadSubject(deps, ctx.principal.id, input);
      const target = { url: managementUrl(subject.config.http) };
      const missing = subject.missing.http;
      if (missing !== undefined) {
        return {
          ok: false,
          target,
          tookMs: 0,
          failure: {
            code: 'SECRET_UNAVAILABLE' as const,
            message: SECRET_UNAVAILABLE[missing],
          },
        };
      }
      const result = await runHttpProbe(
        deps.prober,
        httpEndpointOf(subject),
        probeSignal(ctx.signal),
      );
      const tookMs = Math.max(0, ctx.now() - started);
      if (!result.ok) {
        return {
          ok: false,
          target,
          tookMs,
          failure: httpFailure(result.failure.reason),
        };
      }
      const { facts } = result;
      const product = clip(facts.product);
      const version = clip(facts.version);
      const clusterName = clip(facts.clusterName);
      const user = clip(facts.user);
      return {
        ok: true,
        target,
        tookMs,
        broker: {
          ...(product === undefined ? {} : { product }),
          ...(version === undefined ? {} : { version }),
          ...(clusterName === undefined ? {} : { clusterName }),
          ...(user === undefined ? {} : { user }),
          tags: facts.tags
            .slice(0, PROBE_FACTS_MAX)
            .map((tag) => tag.slice(0, 64)),
        },
        // What the broker listens on, so the AMQP form does not have to guess 5672 and 5671.
        amqpPorts: amqpPortsFromListeners(facts.listeners),
      };
    },
  });
