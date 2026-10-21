// What the explorer says, scanned (M0-48 slice E, AC-21): no secret, no broker text and no
// forbidden wording in any answer of inventory.query, overview.get, search.query or explorer.window, whether the
// broker answers, answers something odd, or is down.
import {
  ConnectionIdSchema,
  explorerWindowTopic,
  inventoryQuery,
  overviewGet,
  searchQuery,
} from '@app/contracts';
import {
  createTestContext,
  createTestExecutor,
  createTestPrincipal,
  toProblem,
} from '@app/kernel';
import type { MgmtReadPort } from '@app/ports';
import { describe, expect, it } from 'vitest';

import { createInventoryQueryAction } from '../actions/inventory-query';
import { createOverviewGetAction } from '../actions/overview-get';
import { createSearchQueryAction } from '../actions/search-query';
import { golden, withRoutes } from '../actions/overview-get.fixture';
import { createScriptedBroker, createExplorerFakeDeps } from '../testing';

import { REASONS } from './freshness';
import { OVERVIEW_TEXT } from './overview';
import { createWindowSource } from './window-source';

const CANARY = 'canary-secret-7f3a9c1e';
const TRAP = `amqp://operator:${CANARY}@broker.internal:5672/%2F`;
const STACK =
  'Error: boom\n    at sweepOnce (file:///srv/engine/sweeper.js:12:7)';
/** A broker failure whose own text carries a URL with credentials and a stack trace. */
const trap = (): Error =>
  Object.assign(new Error(`GET ${TRAP} failed\n${STACK}`), {
    code: 'BROKER_UNREACHABLE',
    broker: { protocol: 'http', code: 503, text: `${TRAP} ${STACK}` },
  });

/** Every `reason` string in a value, at any depth. */
function reasons(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(reasons);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, member]) =>
    key === 'reason' && typeof member === 'string' ? [member] : reasons(member),
  );
}

describe('explorer outputs', () => {
  it('AC-21 explorer outputs carry no secret, no broker text and no forbidden wording', async () => {
    const scripted = createScriptedBroker({
      queueCount: 30,
      vhostCount: 2,
      exchangesPerVhost: 2,
    });
    const recording = golden('4.2.9', 'stats-off');
    const healthy = withRoutes(scripted, recording);
    const noAlarms = withRoutes(scripted, {
      ...recording,
      '/api/health/checks/alarms': trap(),
    });
    let mode: 'healthy' | 'alarms-down' | 'down' = 'healthy';
    const mgmt: MgmtReadPort = {
      get: (request, signal) =>
        mode === 'down'
          ? Promise.reject(trap())
          : (mode === 'healthy' ? healthy : noAlarms).get(request, signal),
      stream: (request, signal) => scripted.read.stream(request, signal),
    };
    // The canary sits where a leak could start: the stored connection, and the profile's hazards.
    const base = createExplorerFakeDeps({
      mgmt,
      profile: { hazards: ['stats-off-policy-fields-missing', `x-${CANARY}`] },
    });
    const deps = {
      ...base,
      connections: {
        get: async (id: Parameters<typeof base.connections.get>[0]) => {
          const record = await base.connections.get(id);
          return (
            record && { ...record, config: { password: CANARY, url: TRAP } }
          );
        },
      },
    };

    const seen: unknown[] = [];
    const engine = createTestExecutor();
    engine.executor.register(createInventoryQueryAction(deps));
    engine.executor.register(createOverviewGetAction(deps));
    engine.executor.register(createSearchQueryAction(deps));
    const ask = async (
      def: typeof inventoryQuery | typeof overviewGet | typeof searchQuery,
      input: Record<string, unknown>,
    ) => {
      try {
        const outcome = await engine.executor.run(
          def,
          { cid: 'c1', ...input },
          createTestContext({ idempotencyKey: 'explorer-outputs-0001' }),
        );
        seen.push(outcome);
        return outcome;
      } catch (error) {
        seen.push(toProblem(error));
        return undefined;
      }
    };
    const page = { offset: 0, limit: 500 };
    const everything = async () => {
      await ask(inventoryQuery, { kind: 'queues', window: page });
      await ask(inventoryQuery, { kind: 'exchanges', window: page });
      await ask(overviewGet, {});
      await ask(searchQuery, { text: 'queue' });
      await ask(searchQuery, { text: 'e', kinds: ['exchanges'] });
    };
    const sweep = async () =>
      deps.sweeper.sweepNow(
        ConnectionIdSchema.parse('c1'),
        new AbortController().signal,
      );

    // Cold, then swept, then with the alarm check failing, then with the broker down and a stale index.
    await everything();
    seen.push(await sweep());
    await everything();
    mode = 'alarms-down';
    await everything();
    mode = 'down';
    seen.push(await sweep());
    await everything();
    // Another caller's connection, and one that does not exist.
    await ask(inventoryQuery, { cid: 'c2', kind: 'queues', window: page });
    await ask(overviewGet, { cid: 'c2' });
    await ask(searchQuery, { cid: 'c2', text: 'queue' });

    // The topic: the snapshot and the items of a subscription, and a refused one.
    const source = createWindowSource(deps);
    const rows = deps.sweeper.index(ConnectionIdSchema.parse('c1'));
    const visible = (
      rows?.window({ kind: 'queues', offset: 0, limit: 5 }).rows ?? []
    ).map((row) => row.key);
    const sink = {
      publish: (item: unknown) => seen.push(item),
      remove: (key: string) => seen.push({ removed: key }),
      end: (problem: unknown) => seen.push(problem),
    };
    const principal = createTestPrincipal();
    const params = (cid: string) =>
      explorerWindowTopic.params.parse({ cid, kind: 'queues', keys: visible });
    const stops = [
      source.subscribe(params('c1'), principal, sink),
      source.subscribe(params('c2'), principal, sink),
    ];
    await deps.timers.settle();
    seen.push(source.snapshot(params('c1'), principal).value);
    for (const stop of stops) stop();
    expect(visible).toHaveLength(5);

    const text = JSON.stringify(seen);
    expect(text.length).toBeGreaterThan(5_000);
    expect(text).not.toContain(CANARY);
    expect(text).not.toMatch(/[a-z][a-z0-9+.-]*:\/\/[^\s/"]*@/i);
    expect(text).not.toMatch(/\bat \S+ \(|:\d+:\d+\)|\\n\s+at /);
    expect(text).not.toMatch(/boom|broker\.internal|GET |HTTP \d{3}|ECONN/i);
    expect(text).not.toMatch(/non-destructive|read-only/i);
    // Every reason is a fixed string.
    const allowed = new Set<string>([
      ...Object.values(REASONS),
      OVERVIEW_TEXT.alarmUnreadable,
      'statistics-off',
      'not-reported',
    ]);
    const given = reasons(seen);
    expect(given.length).toBeGreaterThan(0);
    expect(given.filter((reason) => !allowed.has(reason))).toEqual([]);
  });
});
