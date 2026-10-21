// What overview-get.spec.ts runs. Edit this file, not the spec, as the action grows.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MgmtReadPort } from '@app/ports';

import {
  brokerFailure,
  createExplorerFakeDeps,
  type ScriptedBroker,
} from '../testing';
import { createOverviewGetAction } from './overview-get';

/** A valid input: one value for every required field of the contract. */
export const sampleInput = { cid: 'c1' };

/** The action under test, over the fakes of the module's ports (src/testing.ts). */
export function createSubject() {
  return createOverviewGetAction(createExplorerFakeDeps());
}

const GOLDEN = join(
  import.meta.dirname,
  ...['..', '..', '..', '..', '..', 'testing', 'fixtures', 'mgmt'],
);

/** The three answers overview.get reads, as one recording gave them (an Error where the broker answered an error). */
export type OverviewRoutes = Record<
  '/api/overview' | '/api/nodes' | '/api/health/checks/alarms',
  unknown
>;

/** A golden recording (testing/fixtures/mgmt): LavinMQ's alarm check answered 404, so it is an Error. */
export function golden(
  target: '4.2.9' | 'lavinmq-2.10.2',
  mode: 'stats-on' | 'stats-off' | 'default',
): OverviewRoutes {
  const read = (file: string): unknown => {
    const path = join(GOLDEN, target, mode, file);
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as unknown)
      : brokerFailure(404);
  };
  return {
    '/api/overview': read('overview.get.json'),
    '/api/nodes': read('nodes.list.json'),
    '/api/health/checks/alarms': read('health.alarms.json'),
  };
}

/**
 * The scripted broker with these answers on the three cluster paths; every other path, and every
 * request, still goes through (and is recorded by) the scripted broker.
 */
export function withRoutes(
  broker: ScriptedBroker,
  routes: Partial<OverviewRoutes>,
): MgmtReadPort {
  return {
    stream: (request, signal) => broker.read.stream(request, signal),
    get: (request, signal) => {
      const answer = (routes as Record<string, unknown>)[request.path];
      if (answer === undefined) return broker.read.get(request, signal);
      broker.requests.push({
        path: request.path,
        query: request.query ?? {},
        lane: request.lane,
        via: 'get',
      });
      return Promise.resolve().then(() => {
        if (answer instanceof Error) throw answer;
        return request.schema.parse(answer);
      });
    },
  };
}
