import { ENDPOINTS, defineEndpoint } from '@app/adapter-mgmt-http';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AFTER_GET,
  ERROR_PROBES,
  PROMETHEUS_PROBES,
  goldenProfile,
  placeholdersOf,
  planRequests,
} from './plan.ts';

describe('golden plan', () => {
  it('asks for every endpoint of the adapter catalogue, or says why not', () => {
    const { requests, skipped } = planRequests('rabbitmq', 'stats-on', {});
    const covered = new Set([
      ...requests.map((request) => request.id).filter((id) => id !== AFTER_GET),
      ...skipped.map((entry) => entry.id),
    ]);
    expect([...covered].sort()).toEqual(
      ENDPOINTS.map((spec) => spec.id).sort(),
    );
    // Without a connection or a channel to name, only the `.one` endpoints of those are skipped.
    expect(skipped.map((entry) => entry.id).sort()).toEqual([
      'channels.one',
      'connections.one',
    ]);
  });

  it('fills every placeholder: no request still holds a brace', () => {
    const { requests } = planRequests('rabbitmq', 'stats-on', {
      connection: '10.0.0.1:5000 -> 10.0.0.2:5672',
      channel: '10.0.0.1:5000 -> 10.0.0.2:5672 (1)',
    });
    expect(requests.some((request) => request.path.includes('{'))).toBe(false);
    const connection = requests.find(
      (request) => request.id === 'connections.one',
    );
    expect(connection?.path).toBe(
      '/api/connections/10.0.0.1%3A5000%20-%3E%2010.0.0.2%3A5672',
    );
    expect(placeholdersOf('/api/queues/{vhost}/{name}')).toEqual([
      'vhost',
      'name',
    ]);
  });

  it('sends the stats flags only when statistics are off, and only on endpoints that carry statistics', () => {
    const on = planRequests('rabbitmq', 'stats-on', {}).requests;
    const off = planRequests('rabbitmq', 'stats-off', {}).requests;
    expect(on.every((request) => request.query === undefined)).toBe(true);
    const flagged = off.filter((request) => request.query !== undefined);
    expect(flagged.length).toBeGreaterThan(5);
    for (const request of flagged) {
      expect(request.query).toEqual({
        disable_stats: true,
        enable_queue_totals: true,
      });
    }
    const statsIds = new Set(
      ENDPOINTS.filter((spec) => spec.stats).map((spec) => spec.id),
    );
    expect(new Set(flagged.map((request) => request.id))).toEqual(
      new Set([...statsIds].filter((id) => off.some((r) => r.id === id))),
    );
    expect(off.find((request) => request.id === 'overview.get')?.query).toEqual(
      {
        disable_stats: true,
        enable_queue_totals: true,
      },
    );
    expect(
      off.find((request) => request.id === 'policies.list')?.query,
    ).toBeUndefined();
  });

  it('peeks with POST and a body, and picks the queue that suits the product', () => {
    const rabbit = planRequests('rabbitmq', 'stats-on', {}).requests;
    const get = rabbit.find((request) => request.id === 'queues.get');
    expect(get?.method).toBe('POST');
    expect(get?.path).toBe('/api/queues/golden/golden.classic/get');
    expect(get?.body).toMatchObject({ ackmode: 'ack_requeue_true', count: 2 });
    expect(
      rabbit.filter((request) => request.method === 'POST').map((r) => r.id),
    ).toEqual(['queues.get']);
    // The peek is followed by a read of the same queue, to see what it left behind.
    const ids = rabbit.map((request) => request.id);
    expect(ids[ids.indexOf('queues.get') + 1]).toBe(AFTER_GET);
    expect(rabbit.find((request) => request.id === AFTER_GET)?.path).toBe(
      '/api/queues/golden/golden.classic',
    );
    expect(rabbit.find((request) => request.id === 'queues.one')?.path).toBe(
      '/api/queues/golden/golden.quorum',
    );
    const lavin = planRequests('lavinmq', 'default', {}).requests;
    expect(lavin.find((request) => request.id === 'queues.one')?.path).toBe(
      '/api/queues/golden/golden.classic',
    );
  });

  it('refuses an endpoint with a placeholder that the plan does not know', () => {
    const unknown = defineEndpoint({
      id: 'widgets.one',
      template: '/api/widgets/{id}',
      schema: z.object({}),
    });
    expect(() =>
      planRequests('rabbitmq', 'stats-on', {}, [...ENDPOINTS, unknown]),
    ).toThrow(/widgets\.one has placeholders \(id\)/);
  });

  it('has error probes with distinct ids and Prometheus pages', () => {
    const ids = [...ERROR_PROBES, ...PROMETHEUS_PROBES].map(
      (probe) => probe.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ERROR_PROBES.map((probe) => probe.auth)).toEqual(
      expect.arrayContaining([
        'wrong-password',
        'unknown-user',
        'no-management-tag',
        'guest',
      ]),
    );
  });

  it('builds the profile the client rules read', () => {
    const profile = goldenProfile('rabbitmq', '4.1.8', true);
    expect(profile.stats.disabled).toBe(true);
    expect(profile.product).toBe('rabbitmq');
    expect(profile.versions.min).toMatchObject({
      major: 4,
      minor: 1,
      patch: 8,
    });
    expect(() => goldenProfile('rabbitmq', 'not-a-version', false)).toThrow(
      /not a version/,
    );
  });
});
