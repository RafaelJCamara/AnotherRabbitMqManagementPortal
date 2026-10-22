// The part of `testkit:seed-lab` that needs no Docker: how its command line is read and what it will create.
// Whether a real broker accepts these definitions is not proved here (it needs a Docker daemon: run the command).
import { describe, expect, it } from 'vitest';

import {
  addressOf,
  buildDefinitions,
  DEFAULT_SEED_OPTIONS,
  describePlan,
  importBodies,
  parseSeedArgs,
  planSeed,
  type SeedOptions,
} from './seed-plan.ts';

const VERSIONS = ['4.2.9', '4.3.6'];
const parse = (...argv: string[]): SeedOptions | 'help' =>
  parseSeedArgs(argv, VERSIONS);
const parsed = (...argv: string[]): SeedOptions => {
  const result = parse(...argv);
  if (result === 'help') throw new Error('help was not expected');
  return result;
};

describe('seed-lab command line', () => {
  it('SEED-1 no option gives the documented defaults: 300 queues over 2 vhosts, 6 exchanges each, version 4.3.6, build first', () => {
    expect(parse()).toEqual(DEFAULT_SEED_OPTIONS);
    expect(DEFAULT_SEED_OPTIONS).toMatchObject({
      queues: 300,
      vhosts: 2,
      exchanges: 6,
      bindings: 4,
      version: '4.3.6',
      build: true,
      existing: undefined,
    });
  });

  it('SEED-1 every option is read, and a bad one is refused with a message that names it', () => {
    expect(
      parsed(
        '--queues=1200',
        '--vhosts=3',
        '--exchanges=0',
        '--bindings=2',
        '--version=4.2.9',
        '--no-build',
        '--user=admin',
        '--password=pw',
      ),
    ).toMatchObject({
      queues: 1200,
      vhosts: 3,
      exchanges: 0,
      bindings: 2,
      version: '4.2.9',
      build: false,
      user: 'admin',
      password: 'pw',
    });
    expect(parse('--help')).toBe('help');
    expect(parse('-h')).toBe('help');
    expect(parsed('--existing=http://127.0.0.1:15672/some/path').existing).toBe(
      'http://127.0.0.1:15672',
    );
    for (const [argv, message] of [
      [['--queues=0'], '--queues must be between 1 and 100000'],
      [['--queues=100001'], '--queues must be between 1 and 100000'],
      [['--queues=ten'], '--queues must be a whole number'],
      [['--vhosts=9'], '--vhosts must be between 1 and 8'],
      [['--exchanges=51'], '--exchanges must be between 0 and 50'],
      [['--bindings=21'], '--bindings must be between 0 and 20'],
      [['--version=9.9.9'], '"9.9.9" is not a lab version'],
      [['--existing=not a url'], '--existing must be a URL'],
      [['--existing=ftp://host'], '--existing must be an http or https URL'],
      [['--user='], '--user must not be empty'],
      [['--colour=red'], 'unknown option --colour=red'],
      [['queues=5'], 'unknown option queues=5'],
    ] as const) {
      expect(() => parse(...argv), argv.join(' ')).toThrow(message);
    }
  });
});

describe('seed-lab plan', () => {
  it('SEED-2 the default plan puts 300 queues in two vhosts, three types, with exchanges of four types and bindings to queues and to exchanges', () => {
    const plan = planSeed(DEFAULT_SEED_OPTIONS);
    expect(plan.vhosts).toEqual(['shop', 'billing']);
    expect(plan.queues).toBe(300);
    expect(plan.queuesPerVhost).toEqual({ shop: 150, billing: 150 });
    // A block of ten queues is seven classic, two quorum, one stream.
    expect(plan.queuesByType).toEqual({ classic: 210, quorum: 60, stream: 30 });
    expect(plan.exchanges).toBe(12);

    const definitions = buildDefinitions(DEFAULT_SEED_OPTIONS);
    expect(new Set(definitions.exchanges.map((e) => e.type))).toEqual(
      new Set(['direct', 'topic', 'fanout', 'headers']),
    );
    const toQueues = definitions.bindings.filter(
      (b) => b.destination_type === 'queue',
    );
    const toExchanges = definitions.bindings.filter(
      (b) => b.destination_type === 'exchange',
    );
    // Per vhost: 6 exchanges x 4 queues, and 5 exchanges bound to the first.
    expect(toQueues).toHaveLength(2 * 6 * 4);
    expect(toExchanges).toHaveLength(2 * 5);
    expect(plan.bindings).toBe(toQueues.length + toExchanges.length);
  });

  it('SEED-2 the same options always give the same names, a binding never leaves its vhost, and no name is used twice in a vhost', () => {
    const options = { ...DEFAULT_SEED_OPTIONS, queues: 57, vhosts: 3 };
    const first = buildDefinitions(options);
    expect(buildDefinitions(options)).toEqual(first);
    expect(first.vhosts).toEqual(['shop', 'billing', 'shipping']);
    const byVhost = new Map<string, Set<string>>();
    for (const queue of first.queues) {
      const names = byVhost.get(queue.vhost) ?? new Set<string>();
      expect(names.has(queue.name)).toBe(false);
      names.add(queue.name);
      byVhost.set(queue.vhost, names);
    }
    const exchanges = new Set(
      first.exchanges.map((e) => `${e.vhost}/${e.name}`),
    );
    for (const binding of first.bindings) {
      expect(exchanges.has(`${binding.vhost}/${binding.source}`)).toBe(true);
      const known =
        binding.destination_type === 'queue'
          ? byVhost.get(binding.vhost)?.has(binding.destination)
          : exchanges.has(`${binding.vhost}/${binding.destination}`);
      expect(known, JSON.stringify(binding)).toBe(true);
    }
    // Past the four named vhosts the names are numbered.
    expect(buildDefinitions({ ...options, vhosts: 6 }).vhosts.slice(4)).toEqual(
      ['lab-5', 'lab-6'],
    );
  });

  it('SEED-2 a bindings count larger than the queues of a vhost does not count the same binding twice', () => {
    // Three exchanges (direct, topic, fanout) and 2 queues, each exchange asked to bind 10 times. A fanout exchange
    // has no routing key, so its ten asks are the same two bindings: the broker keeps two, so the plan counts two.
    const small = {
      queues: 2,
      vhosts: 1,
      exchanges: 3,
      bindings: 10,
    };
    const definitions = buildDefinitions(small);
    const keys = definitions.bindings.map(
      (b) =>
        `${b.source}|${b.destination_type}|${b.destination}|${b.routing_key}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    const fanout = definitions.bindings.filter(
      (b) => b.source === 'ex.fanout.02' && b.destination_type === 'queue',
    );
    expect(fanout).toHaveLength(2);
    expect(planSeed({ ...DEFAULT_SEED_OPTIONS, ...small }).bindings).toBe(
      keys.length,
    );
  });

  it('SEED-2 zero exchanges and zero bindings give queues only, and the smallest plan is one queue in one vhost', () => {
    const plan = planSeed({
      ...DEFAULT_SEED_OPTIONS,
      queues: 1,
      vhosts: 1,
      exchanges: 0,
      bindings: 0,
    });
    expect(plan).toMatchObject({ queues: 1, exchanges: 0, bindings: 0 });
    expect(plan.queuesByType).toEqual({ classic: 1, quorum: 0, stream: 0 });
  });

  it('SEED-3 the imports go in an order a broker accepts: vhosts, permissions and exchanges first, then queues in blocks, then bindings', () => {
    const options = { ...DEFAULT_SEED_OPTIONS, queues: 5_100 };
    const bodies = importBodies(buildDefinitions(options), 'guest');
    const keys = bodies.map((body) => Object.keys(body).sort().join(','));
    expect(keys).toEqual([
      'exchanges,permissions,vhosts',
      'queues',
      'queues',
      'queues',
      'bindings',
    ]);
    // The first body gives the login a permission on every vhost it creates (a login sees a vhost only with one).
    const first = bodies[0] as {
      vhosts: { name: string }[];
      permissions: { user: string; vhost: string }[];
    };
    expect(first.vhosts.map((v) => v.name)).toEqual(['shop', 'billing']);
    expect(first.permissions.map((p) => [p.user, p.vhost])).toEqual([
      ['guest', 'shop'],
      ['guest', 'billing'],
    ]);
    // Blocks are at most 2,500 and together hold every queue once.
    const queueBlocks = bodies.slice(1, 4) as { queues: unknown[] }[];
    expect(queueBlocks.map((b) => b.queues.length)).toEqual([2500, 2500, 100]);
    expect(planSeed(options).requests).toBe(bodies.length);
    // A different login gets the permissions.
    const other = importBodies(buildDefinitions(options), 'admin')[0] as {
      permissions: { user: string }[];
    };
    expect(new Set(other.permissions.map((p) => p.user))).toEqual(
      new Set(['admin']),
    );
  });

  it('SEED-3 each queue is durable, never auto-delete, and carries its type', () => {
    const { queues } = buildDefinitions({
      ...DEFAULT_SEED_OPTIONS,
      queues: 10,
    });
    expect(queues.map((q) => q.arguments['x-queue-type'])).toEqual([
      'classic',
      'classic',
      'classic',
      'classic',
      'classic',
      'classic',
      'classic',
      'quorum',
      'quorum',
      'stream',
    ]);
    for (const queue of queues) {
      expect(queue.durable).toBe(true);
      expect(queue.auto_delete).toBe(false);
    }
  });

  it('SEED-4 the plan is described in words before anything is created, and an address is read from a URL', () => {
    const lines = describePlan(planSeed(DEFAULT_SEED_OPTIONS));
    expect(lines.join('\n')).toContain('shop, billing');
    expect(lines.join('\n')).toContain(
      '300 (150 in shop, 150 in billing; 210 classic, 60 quorum, 30 stream)',
    );
    expect(addressOf('http://127.0.0.1:49153')).toEqual({
      host: '127.0.0.1',
      port: 49153,
    });
    expect(addressOf('amqp://127.0.0.1:49154')).toEqual({
      host: '127.0.0.1',
      port: 49154,
    });
    expect(addressOf('http://broker.local').port).toBe(80);
    expect(addressOf('amqp://broker.local').port).toBe(5672);
  });
});
