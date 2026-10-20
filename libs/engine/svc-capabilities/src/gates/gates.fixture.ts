// Helpers of the gate, era and allowed-actions specs: probe a scripted broker (the golden fixtures,
// never the adapter) and build its profile. For specs only; not part of the public API.
import { ConnectionIdSchema } from '@app/contracts';
import { semanticsRegistry } from '@app/semantics';

import {
  fixtureRoutes,
  type FixtureMode,
  type FixtureTarget,
} from '../fixtures';
import { buildProfile } from '../profile-builder';
import { runProbe } from '../probe/run';
import {
  brokerError,
  createFakeWire,
  createScriptedMgmt,
  type FakeWire,
  type Route,
} from '../testing';

const CID = ConnectionIdSchema.parse('c1');

export const AMAZON_HOST = 'b-1234.mq.eu-west-1.amazonaws.com';

const asList = (route: Route): Record<string, unknown>[] =>
  route as Record<string, unknown>[];

/** A recording's routes with some answers replaced. */
export const brokerRoutes = (
  target: FixtureTarget,
  changes: Readonly<Record<string, Route>> = {},
  mode?: FixtureMode,
): Record<string, Route> => ({ ...fixtureRoutes(target, mode), ...changes });

/** The 4.2.9 recording as Amazon MQ answers: operator-policy edits off, no stream or tracing plugin, no event or trace exchange. */
export function amazonRoutes(
  options: { keepStreams?: boolean } = {},
): Record<string, Route> {
  const base = fixtureRoutes('4.2.9');
  const removed = ['rabbitmq_tracing', 'rabbitmq_event_exchange'].concat(
    options.keepStreams === true
      ? []
      : ['rabbitmq_stream', 'rabbitmq_stream_management'],
  );
  const scripts = ['tracing.js'].concat(
    options.keepStreams === true ? [] : ['stream.js'],
  );
  return {
    ...base,
    '/api/overview': {
      ...(base['/api/overview'] as object),
      is_op_policy_updating_enabled: false,
    },
    '/api/nodes': asList(base['/api/nodes']).map((node) => ({
      ...node,
      enabled_plugins: (node.enabled_plugins as string[]).filter(
        (plugin) => !removed.includes(plugin),
      ),
    })),
    '/api/extensions': asList(base['/api/extensions']).filter(
      (extension) => !scripts.includes(String(extension.javascript)),
    ),
    '/api/exchanges/%2F/amq.rabbitmq.event': brokerError(404),
    '/api/exchanges/%2F/amq.rabbitmq.trace': brokerError(404),
  };
}

export function wireFor(
  host?: string,
  amqp?: FakeWire['amqpResult'],
): FakeWire {
  const wire = createFakeWire();
  if (host !== undefined) wire.target = { host, managementTls: true };
  if (amqp !== undefined) wire.amqpResult = amqp;
  return wire;
}

/** Probes a scripted broker and builds the profile, without an action around it. */
export async function probeBroker(
  routes: Readonly<Record<string, Route>>,
  options: { wire?: FakeWire; lastVerified?: readonly string[] } = {},
) {
  const run = await runProbe({
    connectionId: CID,
    mgmt: createScriptedMgmt(routes).read,
    wire: options.wire ?? createFakeWire(),
    registry: semanticsRegistry,
    signal: new AbortController().signal,
  });
  const profile = buildProfile({
    connectionId: CID,
    probedAt: 5_000,
    facts: run.facts,
    registry: semanticsRegistry,
    lastVerified: options.lastVerified ?? [],
  });
  return { profile, facts: run.facts };
}
