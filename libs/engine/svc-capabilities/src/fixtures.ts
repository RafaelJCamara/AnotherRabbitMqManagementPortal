// The golden fixtures (testing/fixtures, M0-25) as the routes of a scripted management API: what a
// real RabbitMQ 3.13.7 to 4.3.6 (statistics on and off) and LavinMQ 2.10.2 answered, replayed
// through a fake `MgmtReadPort`, never through the adapter. For specs only; not part of the public API.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { brokerError, type Route } from './testing';

const ROOT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'testing',
  'fixtures',
  'mgmt',
);

export type FixtureTarget =
  | '3.13.7'
  | '4.0.9'
  | '4.1.8'
  | '4.2.9'
  | '4.3.6'
  | 'lavinmq-2.10.2';
export type FixtureMode = 'stats-on' | 'stats-off' | 'default';

interface Manifest {
  readonly entries: readonly {
    readonly id: string;
    readonly status: number;
    readonly file: string;
  }[];
}

/** The answers of one recording by endpoint id (`overview.get`): a value, or the error of its status. */
function recording(target: FixtureTarget, mode: FixtureMode) {
  const dir = join(ROOT, target, mode);
  if (!existsSync(join(dir, 'manifest.json'))) {
    throw new Error(`no fixture recording ${target}/${mode}`);
  }
  const manifest = JSON.parse(
    readFileSync(join(dir, 'manifest.json'), 'utf8'),
  ) as Manifest;
  return (id: string): Route => {
    const entry = manifest.entries.find((candidate) => candidate.id === id);
    if (entry?.status !== 200) return brokerError(entry?.status ?? 404);
    const text = readFileSync(join(dir, entry.file), 'utf8');
    return JSON.parse(text) as unknown;
  };
}

const items = (answer: Route): unknown[] => {
  if (Array.isArray(answer)) return answer as unknown[];
  const envelope = (answer as { items?: unknown } | undefined)?.items;
  return Array.isArray(envelope) ? (envelope as unknown[]) : [];
};

/** The routes a probe of that broker meets. An exchange is found in the recorded exchange list. */
export function fixtureRoutes(
  target: FixtureTarget,
  mode: FixtureMode = target.startsWith('lavinmq') ? 'default' : 'stats-on',
): Record<string, Route> {
  const answer = recording(target, mode);
  const exchanges = items(answer('exchanges.list')).filter(
    (exchange) => (exchange as { vhost?: string }).vhost === '/',
  );
  const exchangeRoute = (name: string): Route =>
    exchanges.find(
      (exchange) => (exchange as { name?: string }).name === name,
    ) ?? brokerError(404);
  return {
    '/api/overview': answer('overview.get'),
    '/api/whoami': answer('whoami.get'),
    '/api/extensions': answer('extensions.list'),
    '/api/nodes': answer('nodes.list'),
    '/api/feature-flags': answer('featureFlags.list'),
    '/api/deprecated-features/used': answer('deprecatedFeatures.used'),
    '/api/policies': answer('policies.list'),
    '/api/operator-policies': answer('operatorPolicies.list'),
    '/api/users': answer('users.list'),
    '/api/exchanges/%2F/amq.rabbitmq.event':
      exchangeRoute('amq.rabbitmq.event'),
    '/api/exchanges/%2F/amq.rabbitmq.trace':
      exchangeRoute('amq.rabbitmq.trace'),
  };
}
