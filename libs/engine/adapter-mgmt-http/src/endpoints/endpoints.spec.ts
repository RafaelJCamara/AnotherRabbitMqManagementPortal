import { describe, expect, it } from 'vitest';

import type { ConnectionId } from '@app/contracts';

import { productFromOverview } from '../product.ts';
import { assertSafePath, shapeRequest } from '../query.ts';
import { profileOf } from '../test-support.ts';
import {
  ENDPOINTS,
  bindings,
  channels,
  definitions,
  fillTemplate,
  getRequest,
  health,
  matchEndpoint,
  nodes,
  overview,
  queues,
  whoami,
} from './index.ts';

describe('catalogue', () => {
  it('has a unique id and a unique template for every endpoint', () => {
    const ids = ENDPOINTS.map((spec) => spec.id);
    const templates = ENDPOINTS.map((spec) => spec.template);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(templates).size).toBe(templates.length);
    expect(ENDPOINTS.length).toBeGreaterThanOrEqual(40);
  });

  it('matches every endpoint by its own filled path, to itself and no other', () => {
    for (const spec of ENDPOINTS) {
      const params = Object.fromEntries(
        [...spec.template.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => [
          m[1] ?? '',
          m[1] === 'vhost' ? '/' : 'a b',
        ]),
      );

      expect(matchEndpoint(fillTemplate(spec.template, params))?.id).toBe(
        spec.id,
      );
    }
  });

  it('encodes every placeholder: a vhost of / is %2F and a slash cannot add a segment', () => {
    expect(fillTemplate(queues.one.template, { vhost: '/', name: 'a/b' })).toBe(
      '/api/queues/%2F/a%2Fb',
    );
    expect(() => fillTemplate(queues.one.template, { vhost: '/' })).toThrow(
      /needs the parameter name/,
    );
  });

  it('every paged endpoint is a list and only lists are paged', () => {
    for (const spec of ENDPOINTS) {
      const single = /\{(name|user)\}$|\/(get)$/.test(spec.template);
      expect(spec.paged && single).toBe(false);
    }
    expect(queues.list.paged).toBe(true);
    expect(overview.paged).toBe(false);
    expect(bindings.ofQueue.paged).toBe(true);
  });

  it('builds the request the scheduler runs', () => {
    const request = getRequest(queues.inVhost, {
      connectionId: 'c1' as ConnectionId,
      params: { vhost: '/' },
      query: { name: 'orders' },
      lane: 'background',
    });

    expect(request).toMatchObject({
      path: '/api/queues/%2F',
      query: { name: 'orders' },
      lane: 'background',
    });
    expect(request.schema).toBe(queues.inVhost.schema);
  });
});

describe('schemas', () => {
  it('reads whoami tags from a list and from a comma-separated string', () => {
    expect(
      whoami.schema.parse({ name: 'a', tags: ['administrator'] }).tags,
    ).toEqual(['administrator']);
    expect(
      whoami.schema.parse({ name: 'a', tags: 'management,monitoring' }).tags,
    ).toEqual(['management', 'monitoring']);
    expect(whoami.schema.parse({ name: 'a', tags: '' }).tags).toEqual([]);
  });

  it('tolerates the fields another product or a stats-off broker leaves out', () => {
    const queue = queues.one.schema.parse({
      name: 'q',
      vhost: '/',
      future_field: 1,
    });

    expect(queue).toEqual({ name: 'q', vhost: '/' });
    expect(() => queues.one.schema.parse({ vhost: '/' })).toThrow();
  });

  it('reads an overview of a broker that has no rabbitmq_version', () => {
    const parsed = overview.schema.parse({
      node: 'lavinmq@n1',
      lavinmq_version: '2.10.2',
    });

    expect(productFromOverview(parsed)).toBe('lavinmq');
  });

  it('never reads a password hash', () => {
    const user = ENDPOINTS.find(
      (spec) => spec.id === 'users.one',
    )?.schema.parse({
      name: 'u',
      tags: ['monitoring'],
      password_hash: 'hash',
    });

    expect(JSON.stringify(user)).not.toContain('hash');
  });

  it('reads a health result and a definitions header', () => {
    expect(health.alarms.schema.parse({ status: 'ok' })).toEqual({
      status: 'ok',
    });
    expect(
      definitions.all.schema.parse({
        rabbit_version: '4.3.6',
        queues: [{ name: 'q' }],
      }).queues,
    ).toHaveLength(1);
  });
});

describe('product from the overview', () => {
  it.each([
    [{ product_name: 'RabbitMQ' }, 'rabbitmq'],
    [{ rabbitmq_version: '4.3.6' }, 'rabbitmq'],
    [{ product_name: 'VMware Tanzu RabbitMQ' }, 'tanzu-rabbitmq'],
    [{ product_name: 'LavinMQ' }, 'lavinmq'],
    [{ lavinmq_version: '2.10.2' }, 'lavinmq'],
    [{}, 'unknown'],
  ] as const)('%j is %s', (overviewBody, product) => {
    expect(productFromOverview(overviewBody)).toBe(product);
  });
});

describe('query shaping', () => {
  const rabbit = profileOf('4.3.6');
  const yes = () => true;

  it("sets the columns of an endpoint and keeps the caller's own", () => {
    const defaults = shapeRequest('/api/nodes', undefined, rabbit, yes);
    const own = shapeRequest(
      '/api/nodes',
      { columns: 'name,running' },
      rabbit,
      yes,
    );

    expect(defaults.query.columns).toBe(nodes.columns?.join(','));
    expect(own.query.columns).toBe('name,running');
    expect(defaults.query.page).toBeUndefined();
  });

  it.each([0, -3, 'abc', 2.9, 500, 501, 10_000])(
    'clamps page_size %j into 1..500',
    (requested) => {
      const sent = shapeRequest(
        '/api/queues',
        { page_size: requested as number },
        rabbit,
        yes,
      );

      expect(sent.query.page_size).toBeGreaterThanOrEqual(1);
      expect(sent.query.page_size).toBeLessThanOrEqual(500);
    },
  );

  it('encodes a deterministic target and rejects bad keys, values and columns', () => {
    const sent = shapeRequest(
      '/api/queues',
      { name: 'a b&c', use_regex: true },
      rabbit,
      yes,
    );

    expect(sent.target).toContain('name=a%20b%26c&');
    expect(sent.target.indexOf('columns=')).toBeLessThan(
      sent.target.indexOf('name='),
    );
    expect(() =>
      shapeRequest('/api/queues', { 'a b': 1 }, rabbit, yes),
    ).toThrow();
    expect(() =>
      shapeRequest('/api/queues', { x: 'a\nb' }, rabbit, yes),
    ).toThrow();
    expect(() =>
      shapeRequest('/api/queues', { x: Number.NaN }, rabbit, yes),
    ).toThrow();
    expect(() =>
      shapeRequest('/api/queues', { columns: 'a;b' }, rabbit, yes),
    ).toThrow();
  });

  it('accepts the channel flag only when the capability says so', () => {
    const asked = { disable_stats: true };
    const no = shapeRequest(channels.list.template, asked, rabbit, () => false);
    const ok = shapeRequest(
      channels.list.template,
      asked,
      rabbit,
      (id) => id === 'channelsAcceptDisableStats',
    );

    expect(no.query.disable_stats).toBeUndefined();
    expect(ok.query.disable_stats).toBe(true);
  });

  it('accepts safe paths and refuses the others', () => {
    expect(() => {
      assertSafePath('/api/queues/%2F/q%201');
    }).not.toThrow();
    for (const bad of [
      'api/x',
      '//x',
      '/a/../b',
      '/a/%2E%2E/b',
      '/a?b',
      '/a#b',
      '/a b',
      '/a%zz',
      '/a\\b',
    ]) {
      expect(() => {
        assertSafePath(bad);
      }).toThrow();
    }
  });
});
