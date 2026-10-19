// The golden fixtures (M0-25): real answers of the five lab RabbitMQ versions (statistics on and
// off) and LavinMQ 2.10.2, replayed through the real client. `pnpm nx run adapter-mgmt-http:test-golden`.
//
// Nothing here needs a broker: the answers are committed in testing/fixtures and were recorded by
// `pnpm nx run adapter-mgmt-http:record-golden`. A change in what a broker answers shows up as a
// failure of the table that pins it, and the nightly `golden-refresh` workflow is how it is noticed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { semanticsRegistry } from '@app/semantics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ENDPOINTS } from '../src/endpoints/index.ts';
import { QueueSchema } from '../src/endpoints/queues.ts';
import { MgmtHttpError } from '../src/errors.ts';
import {
  normaliseGetMessagesBody,
  productFromOverview,
} from '../src/product.ts';
import {
  CID,
  harness,
  profileOf,
  startMgmtServer,
  type Harness,
  type MgmtServer,
} from '../src/test-support.ts';
import {
  FIXTURES_ROOT,
  entryOf,
  itemsOf,
  jsonOf,
  loadRecordings,
  textOf,
  type Entry,
  type Recording,
} from './fixtures.ts';

const MGMT = loadRecordings('mgmt');
const PROMETHEUS = loadRecordings('prometheus');

const RABBITMQ_VERSIONS = ['3.13.7', '4.0.9', '4.1.8', '4.2.9', '4.3.6'];
const LAVINMQ = 'lavinmq-2.10.2/default';
const RABBITMQ = MGMT.filter((rec) => rec.manifest.product === 'rabbitmq');
const STATS_OFF = RABBITMQ.filter((rec) => rec.manifest.stats === 'off');
const STATS_ON = RABBITMQ.filter((rec) => rec.manifest.stats === 'on');

function recording(key: string): Recording {
  const found = MGMT.find((rec) => rec.key === key);
  if (found === undefined) throw new Error(`no recording ${key}`);
  return found;
}

/** The profile the client was given when the fixture was recorded. */
const profileFor = (rec: Recording) =>
  profileOf(rec.manifest.version, {
    statsOff: rec.manifest.stats === 'off',
    product: rec.manifest.product,
  });

/** What the registry reads (it also wants the feature flags, which are not recorded as a profile). */
const hazardsFor = (rec: Recording): string[] =>
  semanticsRegistry.hazards({ ...profileFor(rec), featureFlags: {} });

const capabilityFor = (rec: Recording, id: string): boolean =>
  semanticsRegistry.capability(id, profileFor(rec));

describe('AC-1 the recordings', () => {
  it('AC-1 exist for 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6 with statistics on and off, and for LavinMQ 2.10.2, for management and Prometheus', () => {
    const expected = [
      ...RABBITMQ_VERSIONS.flatMap((version) => [
        `${version}/stats-off`,
        `${version}/stats-on`,
      ]),
      LAVINMQ,
    ].sort();
    expect(MGMT.map((rec) => rec.key).sort()).toEqual(expected);
    expect(PROMETHEUS.map((rec) => rec.key).sort()).toEqual(expected);
  });

  it('AC-1 say which product and version answered, from which pinned image, in which statistics mode, from which seed', () => {
    const seeds = new Set<string>();
    for (const rec of [...MGMT, ...PROMETHEUS]) {
      const { manifest } = rec;
      expect(manifest.schema).toBe(1);
      expect(manifest.version, rec.key).toBe(
        rec.target.replace(/^lavinmq-/, ''),
      );
      expect(manifest.digest, rec.key).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(manifest.image, rec.key).toMatch(
        manifest.product === 'rabbitmq'
          ? /^rabbitmq:\d+\.\d+\.\d+-management$/
          : /^cloudamqp\/lavinmq:\d+\.\d+\.\d+$/,
      );
      expect(manifest.stats, rec.key).toBe(
        manifest.product === 'lavinmq'
          ? 'n/a'
          : rec.mode === 'stats-off'
            ? 'off'
            : 'on',
      );
      expect(manifest.brokerConfig.length > 0, rec.key).toBe(
        rec.mode !== 'stats-on',
      );
      seeds.add(`${manifest.seed.id}:${manifest.seed.sha256}`);
    }
    // One seed produced every recording.
    expect(seeds.size).toBe(1);
  });

  it('AC-1 hold a file for every manifest entry, of the size the manifest says', () => {
    for (const rec of [...MGMT, ...PROMETHEUS]) {
      const files = new Set(readdirSync(rec.dir));
      for (const entry of rec.manifest.entries) {
        expect(files.has(entry.file), `${rec.key}/${entry.file}`).toBe(true);
        expect(
          statSync(join(rec.dir, entry.file)).size,
          `${rec.key}/${entry.file}`,
        ).toBe(entry.bytes);
        files.delete(entry.file);
      }
      files.delete('manifest.json');
      expect([...files], `${rec.key} has files no entry names`).toEqual([]);
    }
  });

  it('AC-1 cover every endpoint of the catalogue: recorded, or skipped with a reason', () => {
    for (const rec of MGMT) {
      const recorded = new Set(rec.manifest.entries.map((entry) => entry.id));
      const skipped = new Map(
        rec.manifest.skipped.map((entry) => [entry.id, entry.reason]),
      );
      for (const spec of ENDPOINTS) {
        const covered = recorded.has(spec.id) || skipped.has(spec.id);
        expect(covered, `${rec.key} has neither ${spec.id} nor a reason`).toBe(
          true,
        );
      }
      // Only the endpoints that name one connection or channel can be skipped, and only when the
      // broker listed none (statistics off).
      for (const id of skipped.keys()) {
        expect(['connections.one', 'channels.one']).toContain(id);
        expect(rec.manifest.stats).toBe('off');
      }
    }
  });
});

describe('fixtures hold no secret and nothing of the machine that recorded them', () => {
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(json|txt|prom)$/.test(name)) {
        files.push({
          path: full.slice(FIXTURES_ROOT.length + 1),
          text: readFileSync(full, 'utf8'),
        });
      }
    }
  };
  for (const kind of ['mgmt', 'prometheus']) walk(join(FIXTURES_ROOT, kind));

  // The recorder plants this as the password of the seeded users and as the wrong password of the
  // error probes (libs/testkit/src/golden/scrub.ts), and refuses to write a file that holds it.
  const CANARY = /canary-secret-/i;
  const PATTERNS: readonly [string, RegExp][] = [
    ['a canary secret', CANARY],
    ['a JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/],
    ['a PEM block', /-----BEGIN [A-Z0-9 ]+-----/],
    ['a Bearer value', /\bBearer\s+(?!<scrubbed>)[A-Za-z0-9._~+/=-]{8,}/],
    ['a Basic value', /\bBasic\s+(?!<scrubbed>)[A-Za-z0-9+/=]{8,}/],
    [
      'credentials in a URL',
      /\b[a-z][a-z0-9+.-]*:\/\/(?!<scrubbed>@)[^/\s:@"']+:[^/\s@"']+@/i,
    ],
    ['an unscrubbed password hash', /"password_hash":\s*"(?!<scrubbed>")/],
    ['a node name of a real machine', /rabbit@(?!lab-node\b|n0\b)[\w.-]+/],
    [
      'a container id',
      /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{12}\b(?![0-9a-f])/,
    ],
    [
      'a private address',
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/,
    ],
    ['a home directory', /(?:\/home\/(?!user\b)|\/Users\/(?!user\b))[^/\s"']+/],
  ];

  it('scans every committed answer and manifest (more than 500 files)', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it.each(PATTERNS)('does not contain %s', (name, pattern) => {
    // A name in a request path is percent-encoded (`...%20172.17.0.2%3A5672`), which hides an
    // address from a word boundary: scan the text with the escapes read as separators too.
    const offenders = files
      .filter(
        (file) =>
          pattern.test(file.text) ||
          pattern.test(file.text.replace(/%[0-9A-Fa-f]{2}/g, ' ')),
      )
      .map((file) => file.path);
    expect(offenders, name).toEqual([]);
  });

  it('keeps the placeholders the scrubber writes (the scan would pass on empty files too)', () => {
    const joined = files.map((file) => file.text).join('\n');
    expect(joined).toContain('"password_hash": "<scrubbed>"');
    expect(joined).toContain('rabbit@lab-node');
    expect(joined).toContain('192.0.2.1');
  });
});

describe.each(MGMT)('replay of $key through the client', (rec) => {
  let server: MgmtServer;
  let client: Harness;

  beforeAll(async () => {
    server = await startMgmtServer();
    client = harness(server.port, { profile: profileFor(rec) });
  });
  afterAll(async () => {
    client.client.close();
    await server.close();
  });

  const catalogue = new Map(ENDPOINTS.map((spec) => [spec.id, spec]));

  /** Sends the entry through the client; the server answers with the recorded status and body. */
  async function replay(
    entry: Entry,
  ): Promise<
    | { ok: true; value: unknown; saw: { url: string; body: string } }
    | { ok: false; error: unknown; saw: { url: string; body: string } }
  > {
    const text = textOf(rec, entry);
    server.reply(() => ({ status: entry.status, body: text }));
    const before = server.requests.length;
    // `queues.afterGet` reads one queue again after the peek: the schema of `queues.one`.
    const spec = catalogue.get(
      entry.id === 'queues.afterGet' ? 'queues.one' : entry.id,
    );
    const schema = spec?.schema ?? z.unknown();
    try {
      const value =
        entry.method === 'POST'
          ? await client.client.write.send(
              {
                connectionId: CID,
                method: 'POST',
                path: entry.path,
                body: entry.body,
                schema,
              },
              client.signal,
            )
          : await client.client.read.get(
              {
                connectionId: CID,
                path: entry.path,
                ...(entry.query === undefined ? {} : { query: entry.query }),
                schema,
                lane: 'interactive',
              },
              client.signal,
            );
      const seen = server.requests[before];
      return {
        ok: true,
        value,
        saw: { url: seen?.url ?? '', body: seen?.body ?? '' },
      };
    } catch (error) {
      const seen = server.requests[before];
      return {
        ok: false,
        error,
        saw: { url: seen?.url ?? '', body: seen?.body ?? '' },
      };
    }
  }

  it('AC-1 sends the request the manifest records, and every successful answer parses with its endpoint schema', async () => {
    const problems: string[] = [];
    for (const entry of rec.manifest.entries) {
      if (entry.status >= 400) continue;
      const result = await replay(entry);
      if (result.saw.url !== entry.sent) {
        problems.push(
          `${entry.id}: sent ${result.saw.url}, recorded ${entry.sent}`,
        );
      }
      if (entry.method === 'POST') {
        const body: unknown = JSON.parse(result.saw.body);
        if (JSON.stringify(body) !== JSON.stringify(entry.body)) {
          problems.push(`${entry.id}: the body changed on the way`);
        }
      }
      if (!result.ok) {
        problems.push(
          `${entry.id}: did not parse (${result.error instanceof MgmtHttpError ? result.error.detail : String(result.error)})`,
        );
        continue;
      }
      const spec = catalogue.get(entry.id);
      if (spec?.paged === true) {
        const page = result.value as { items: unknown[]; pageSize: number };
        const json = JSON.parse(textOf(rec, entry)) as {
          items?: unknown[];
          page_size?: number;
        };
        const wanted =
          entry.envelope === true
            ? (json.items?.length ?? -1)
            : (json as unknown[]).length;
        if (page.items.length !== wanted) {
          problems.push(
            `${entry.id}: the page holds ${String(page.items.length)} items, the broker sent ${String(wanted)}`,
          );
        }
        if (entry.envelope === true && page.pageSize !== json.page_size) {
          problems.push(
            `${entry.id}: page size ${String(page.pageSize)} is not the broker's ${String(json.page_size)}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('AC-1 turns every recorded failure into the contract error the status map says', async () => {
    const problems: string[] = [];
    let failures = 0;
    for (const entry of rec.manifest.entries) {
      if (entry.status < 400) continue;
      failures += 1;
      const result = await replay(entry);
      if (result.saw.url !== entry.sent) {
        problems.push(
          `${entry.id}: sent ${result.saw.url}, recorded ${entry.sent}`,
        );
      }
      if (result.ok || !(result.error instanceof MgmtHttpError)) {
        problems.push(
          `${entry.id}: expected a MgmtHttpError for ${String(entry.status)}`,
        );
        continue;
      }
      const error = result.error;
      if (error.broker?.code !== entry.status) {
        problems.push(
          `${entry.id}: broker.code ${String(error.broker?.code)} is not ${String(entry.status)}`,
        );
      }
      const wanted = expectedCode(rec, entry);
      if (error.code !== wanted) {
        problems.push(`${entry.id}: ${error.code}, expected ${wanted}`);
      }
    }
    expect(failures).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});

/**
 * The contract error of a recorded failure. 401 is read by the broker's text, a failing channel
 * list on a stats-off broker is a closed capability (the registry says from which release it is
 * not), and every other 400 is a bad request.
 */
function expectedCode(rec: Recording, entry: Entry): string {
  switch (entry.status) {
    case 401:
      return /Not management user/i.test(textOf(rec, entry))
        ? 'FORBIDDEN_BROKER'
        : 'UNAUTHENTICATED';
    case 404:
      return 'NOT_FOUND';
    case 400:
      return entry.id.startsWith('channels.') &&
        rec.manifest.stats === 'off' &&
        !capabilityFor(rec, 'channelsListWithStatsOff')
        ? 'CAPABILITY_MISSING'
        : 'VALIDATION_FAILED';
    case 500:
      return 'BROKER_ERROR';
    default:
      throw new Error(`no expectation for status ${String(entry.status)}`);
  }
}

/** Failures that every recording shares: the probes of a bad login and of a missing object. */
const COMMON_FAILURES: Readonly<Record<string, number>> = {
  'error.wrong-password': 401,
  'error.unknown-user': 401,
  'error.no-management-tag': 401,
  'error.queue-not-found': 404,
};

/** With statistics off the broker refuses these lists (the stats-off 400s, recorded below). */
const STATS_OFF_400 = {
  'channels.list': 400,
  'channels.inVhost': 400,
  'consumers.list': 400,
  'consumers.inVhost': 400,
} as const;

/** `GET /api/vhosts?page=1&page_size=100` is refused on every release after 3.13.7. */
const VHOSTS_PAGE_500 = { 'error.vhosts-paged': 500 } as const;

const LAVINMQ_404 = Object.fromEntries(
  [
    'featureFlags.list',
    'deprecatedFeatures.list',
    'deprecatedFeatures.used',
    'health.alarms',
    'health.localAlarms',
    'health.virtualHosts',
    'health.nodeIsQuorumCritical',
    'health.portListener',
    'health.protocolListener',
    'health.certificateExpiration',
  ].map((id) => [id, 404]),
);

describe('AC-1 the recorded failures are exactly these, no more and no fewer', () => {
  const EXPECTED: Record<string, Record<string, number>> = {
    '3.13.7/stats-on': { ...COMMON_FAILURES },
    '3.13.7/stats-off': { ...COMMON_FAILURES, ...STATS_OFF_400 },
    '4.0.9/stats-on': { ...COMMON_FAILURES, ...VHOSTS_PAGE_500 },
    '4.0.9/stats-off': {
      ...COMMON_FAILURES,
      ...VHOSTS_PAGE_500,
      ...STATS_OFF_400,
    },
    '4.1.8/stats-on': { ...COMMON_FAILURES, ...VHOSTS_PAGE_500 },
    '4.1.8/stats-off': {
      ...COMMON_FAILURES,
      ...VHOSTS_PAGE_500,
      ...STATS_OFF_400,
    },
    '4.2.9/stats-on': { ...COMMON_FAILURES, ...VHOSTS_PAGE_500 },
    '4.2.9/stats-off': {
      ...COMMON_FAILURES,
      ...VHOSTS_PAGE_500,
      ...STATS_OFF_400,
    },
    '4.3.6/stats-on': { ...COMMON_FAILURES, ...VHOSTS_PAGE_500 },
    // 4.3.6 lists channels with statistics off (the fix of #17198) but not per vhost, and still
    // refuses the consumer lists.
    '4.3.6/stats-off': {
      ...COMMON_FAILURES,
      ...VHOSTS_PAGE_500,
      'channels.inVhost': 400,
      'consumers.list': 400,
      'consumers.inVhost': 400,
    },
    // LavinMQ has no feature flags, no deprecated features and no health checks (404), and its
    // 401 answers carry no body.
    [LAVINMQ]: { ...COMMON_FAILURES, ...LAVINMQ_404 },
  };

  it.each(MGMT.map((rec) => rec.key))('%s', (key) => {
    const rec = recording(key);
    const failed = Object.fromEntries(
      rec.manifest.entries
        .filter((entry) => entry.status >= 400)
        .map((entry) => [entry.id, entry.status]),
    );
    expect(failed).toEqual(EXPECTED[key]);
  });

  it('refuses the stats-off lists with the broker’s own words', () => {
    for (const rec of STATS_OFF) {
      const entry = entryOf(rec, 'consumers.list');
      expect(jsonOf(rec, 'consumers.list'), rec.key).toEqual({
        error: 'bad_request',
        reason: 'Stats in management UI are disabled on this node',
      });
      expect(entry.status).toBe(400);
    }
  });
});

describe('AC-1 the recorded LavinMQ deviations', () => {
  const lavin = () => recording(LAVINMQ);
  const rabbit = () => recording('4.3.6/stats-on');

  it('AC-1 names itself LavinMQ: no rabbitmq_version, and the adapter says so', () => {
    const overview = jsonOf(lavin(), 'overview.get') as Record<string, unknown>;
    expect(overview.product_name).toBe('LavinMQ');
    expect(overview.lavinmq_version).toBe('2.10.2');
    expect(overview).not.toHaveProperty('rabbitmq_version');
    expect(overview).not.toHaveProperty('management_version');
    expect(productFromOverview(overview)).toBe('lavinmq');
    const other = jsonOf(rabbit(), 'overview.get') as Record<string, unknown>;
    expect(productFromOverview(other)).toBe('rabbitmq');
    expect(other.rabbitmq_version).toBe('4.3.6');
  });

  it('AC-1 has no extensions, feature flags, deprecated features or health checks', () => {
    expect(jsonOf(lavin(), 'extensions.list')).toEqual([]);
    for (const [id, status] of Object.entries(LAVINMQ_404)) {
      const entry = entryOf(lavin(), id);
      expect(entry.status, id).toBe(status);
      expect(textOf(lavin(), entry).trim(), id).toBe('404 Not Found');
      expect(entry.file, id).toMatch(/\.txt$/);
    }
    // ... where every RabbitMQ answers them.
    for (const rec of RABBITMQ) {
      for (const id of Object.keys(LAVINMQ_404)) {
        expect(entryOf(rec, id).status, `${rec.key} ${id}`).toBe(200);
      }
    }
  });

  it('AC-1 answers a bad login with an empty 401 where RabbitMQ sends a JSON reason', () => {
    for (const id of [
      'error.wrong-password',
      'error.unknown-user',
      'error.no-management-tag',
    ]) {
      expect(textOf(lavin(), entryOf(lavin(), id)), id).toBe('');
      expect(entryOf(lavin(), id).status).toBe(401);
    }
    expect(jsonOf(rabbit(), 'error.no-management-tag')).toEqual({
      error: 'not_authorised',
      reason: 'Not management user',
    });
  });

  it('AC-1 names its node without a host part, and reports no queue type or node on a queue', () => {
    const nodes = jsonOf(lavin(), 'nodes.list') as { name: string }[];
    expect(nodes.map((node) => node.name)).toEqual(['lab-node']);
    expect(jsonOf(rabbit(), 'nodes.list')).toMatchObject([
      { name: 'rabbit@lab-node' },
    ]);
    const queues = itemsOf(jsonOf(lavin(), 'queues.list'));
    expect(queues.length).toBeGreaterThan(0);
    for (const queue of queues) {
      expect(queue, String(queue.name)).not.toHaveProperty('type');
      expect(queue, String(queue.name)).not.toHaveProperty('node');
    }
    for (const queue of itemsOf(jsonOf(rabbit(), 'queues.list'))) {
      expect(queue.type, String(queue.name)).toBeTypeOf('string');
    }
  });

  it('AC-1 takes the seed whole: streams and operator policies exist, and no step was refused', () => {
    expect(lavin().manifest.seed.refused).toEqual([]);
    const policies = itemsOf(jsonOf(lavin(), 'operatorPolicies.list'));
    expect(policies.map((policy) => policy.name)).toEqual(['golden-op']);
    const queues = itemsOf(jsonOf(lavin(), 'queues.list'));
    expect(queues.map((queue) => queue.name)).toContain('golden.stream');
  });

  it('AC-1 is asked to peek with an explicit ackmode and requeue:true, and returns the messages', () => {
    const entry = entryOf(lavin(), 'queues.get');
    expect(entry.body).toMatchObject({
      ackmode: 'ack_requeue_true',
      requeue: true,
      count: 2,
    });
    expect(entry.status).toBe(200);
    const messages = jsonOf(lavin(), 'queues.get') as { routing_key: string }[];
    expect(messages).toHaveLength(2);
    // RabbitMQ is sent the body as written: no requeue key.
    const sent = entryOf(rabbit(), 'queues.get').body as Record<
      string,
      unknown
    >;
    expect(sent).not.toHaveProperty('requeue');
    expect(normaliseGetMessagesBody('rabbitmq', sent)).toEqual(sent);
    expect(normaliseGetMessagesBody('lavinmq', sent)).toEqual(entry.body);
  });

  it('OQ-413 keeps the messages it peeked at: the counts are the same after the peek, with the body the adapter sends', () => {
    for (const rec of [lavin(), ...STATS_ON]) {
      const before = itemsOf(jsonOf(rec, 'queues.list')).find(
        (queue) => queue.name === 'golden.classic',
      );
      const after = jsonOf(rec, 'queues.afterGet') as Record<string, unknown>;
      expect(after.name, rec.key).toBe('golden.classic');
      for (const field of [
        'messages',
        'messages_ready',
        'messages_unacknowledged',
      ]) {
        expect(after[field], `${rec.key} ${field}`).toBe(before?.[field]);
      }
      expect(after.messages_ready, rec.key).toBe(3);
      expect(after.messages_unacknowledged, rec.key).toBe(2);
    }
  });

  it('AC-1 sends no statistics flags to it, whatever the caller asks', () => {
    for (const entry of lavin().manifest.entries) {
      expect(entry.sent, entry.id).not.toMatch(
        /disable_stats|enable_queue_totals/,
      );
    }
  });

  it('AC-1 pages with the envelope where RabbitMQ answers a bare array', () => {
    const rabbitBare = [
      'bindings.list',
      'consumers.list',
      'policies.list',
      'permissions.list',
      'operatorPolicies.list',
    ];
    for (const id of rabbitBare) {
      expect(entryOf(rabbit(), id).envelope, `RabbitMQ ${id}`).toBe(false);
      expect(entryOf(lavin(), id).envelope, `LavinMQ ${id}`).toBe(true);
    }
  });

  it('AC-1 exposes the Prometheus page under its own prefix, on a port that needs --metrics-http-bind to be reached', () => {
    const rec = PROMETHEUS.find((candidate) => candidate.key === LAVINMQ);
    expect(rec?.manifest.brokerConfig).toEqual(['--metrics-http-bind=0.0.0.0']);
    const page = readFileSync(
      join(rec?.dir ?? '', 'prometheus.metrics.prom'),
      'utf8',
    );
    expect(page).toContain('lavinmq_identity_info{lavinmq_version="2.10.2"');
    expect(page).not.toContain('rabbitmq_');
  });
});

describe('AC-2 stats-off fixtures of 4.1.8', () => {
  const off = () => recording('4.1.8/stats-off');
  const on = () => recording('4.1.8/stats-on');
  const quorum = (rec: Recording): Record<string, unknown> =>
    itemsOf(jsonOf(rec, 'queues.list')).find(
      (queue) => queue.name === 'golden.quorum',
    ) ?? {};

  it('AC-2 tolerate the missing policy fields: the queue still parses, without delivery_limit, effective_policy_definition and operator_policy', () => {
    const missing = quorum(off());
    expect(missing.name).toBe('golden.quorum');
    expect(missing).not.toHaveProperty('delivery_limit');
    expect(missing).not.toHaveProperty('effective_policy_definition');
    expect(missing).not.toHaveProperty('operator_policy');
    expect(QueueSchema.safeParse(missing).success).toBe(true);
    const single = jsonOf(off(), 'queues.one');
    expect(QueueSchema.safeParse(single).success).toBe(true);
    expect(single).not.toHaveProperty('delivery_limit');

    // The same queue with statistics on carries all of them.
    const present = quorum(on());
    expect(present.delivery_limit).toBe(7);
    expect(present.policy).toBe('golden-delivery-limit');
    expect(present.effective_policy_definition).toEqual({
      'delivery-limit': 7,
    });
    expect(present).toHaveProperty('operator_policy');
  });

  it('AC-2 are flagged by the hazard table, and statistics on are not', () => {
    expect(hazardsFor(off())).toEqual(
      expect.arrayContaining([
        'stats-off-policy-fields-missing',
        'channels-400-stats-off',
      ]),
    );
    expect(hazardsFor(on())).not.toContain('stats-off-policy-fields-missing');
    expect(hazardsFor(on())).not.toContain('channels-400-stats-off');
    expect(capabilityFor(off(), 'policyFieldsWithStatsOff')).toBe(false);
  });

  it('AC-2 show the channel list failing, which the hazard channels-400-stats-off says', () => {
    expect(entryOf(off(), 'channels.list').status).toBe(400);
    expect(entryOf(on(), 'channels.list').status).toBe(200);
  });
});

describe('the hazard table and the capability cells agree with the fixtures', () => {
  it('stats-off-policy-fields-missing and policyFieldsWithStatsOff: the queue fields are there exactly when the registry says', () => {
    for (const rec of STATS_OFF) {
      const queue =
        itemsOf(jsonOf(rec, 'queues.list')).find(
          (q) => q.name === 'golden.quorum',
        ) ?? {};
      const present =
        'delivery_limit' in queue && 'effective_policy_definition' in queue;
      expect(present, rec.key).toBe(
        capabilityFor(rec, 'policyFieldsWithStatsOff'),
      );
      expect(
        hazardsFor(rec).includes('stats-off-policy-fields-missing'),
        rec.key,
      ).toBe(!present);
    }
  });

  it('channels-400-stats-off and channelsListWithStatsOff: the channel list fails exactly when the registry says', () => {
    for (const rec of STATS_OFF) {
      const refused = entryOf(rec, 'channels.list').status === 400;
      expect(hazardsFor(rec).includes('channels-400-stats-off'), rec.key).toBe(
        refused,
      );
      expect(capabilityFor(rec, 'channelsListWithStatsOff'), rec.key).toBe(
        !refused,
      );
    }
  });

  it('enableQueueTotalsOnQueueLists: with the flag sent, a stats-off list keeps the message counts', () => {
    for (const rec of STATS_OFF) {
      expect(capabilityFor(rec, 'enableQueueTotalsOnQueueLists'), rec.key).toBe(
        true,
      );
      const entry = entryOf(rec, 'queues.list');
      expect(entry.sent, rec.key).toContain('enable_queue_totals=true');
      // A stream has no counts in a stats-off list on any release (OQ-431), so it is left out here.
      for (const queue of itemsOf(jsonOf(rec, 'queues.list')).filter(
        (item) => item.name !== 'golden.stream',
      )) {
        expect(queue.messages, `${rec.key} ${String(queue.name)}`).toBeTypeOf(
          'number',
        );
        expect(
          queue.messages_ready,
          `${rec.key} ${String(queue.name)}`,
        ).toBeTypeOf('number');
      }
    }
  });

  it('never sends disable_stats to the channel list on a broker that refuses it, and only there', () => {
    for (const rec of STATS_OFF) {
      const entry = entryOf(rec, 'channels.list');
      expect(entry.sent.includes('disable_stats'), rec.key).toBe(
        capabilityFor(rec, 'channelsAcceptDisableStats'),
      );
    }
  });

  // The one recording whose connection list is empty with the statistics collector off.
  const LISTS_NO_CONNECTION_STATS_OFF = new Set(['4.3.6/stats-off']);

  it('records what the hazard table does not say yet (OQ-431)', () => {
    for (const rec of STATS_OFF) {
      // The consumer lists are refused with statistics off on every release.
      expect(entryOf(rec, 'consumers.inVhost').status, rec.key).toBe(400);
      expect(
        hazardsFor(rec).some((id) => id.includes('consumers')),
        rec.key,
      ).toBe(false);
      // The node list keeps three fields.
      const nodes = jsonOf(rec, 'nodes.list') as Record<string, unknown>[];
      expect(Object.keys(nodes[0] ?? {}).sort(), rec.key).toEqual(
        expect.arrayContaining(['being_drained', 'name', 'running']),
      );
      expect(nodes[0], rec.key).not.toHaveProperty('enabled_plugins');
      // A classic queue under a policy and an operator policy still lacks the operator policy and
      // the effective definition: the fix of 4.2.5 and 4.3.0 reached the quorum queues only.
      const classic =
        itemsOf(jsonOf(rec, 'queues.list')).find(
          (q) => q.name === 'golden.classic',
        ) ?? {};
      const stream =
        itemsOf(jsonOf(rec, 'queues.list')).find(
          (q) => q.name === 'golden.stream',
        ) ?? {};
      expect(stream.type, rec.key).toBe('stream');
      expect(stream, rec.key).not.toHaveProperty('messages');
      expect(classic.policy, rec.key).toBe('golden-ttl');
      expect(classic, rec.key).not.toHaveProperty('operator_policy');
      expect(classic, rec.key).not.toHaveProperty(
        'effective_policy_definition',
      );
    }
    // With the collector off the connection list keeps four fields up to 4.2.9 and is empty on
    // 4.3.6, although the overview counts the connection on all of them. The capability
    // connectionStaticInfoWithStatsOff (4.2.6 and later) says the opposite way round.
    for (const rec of STATS_OFF) {
      const connections = itemsOf(jsonOf(rec, 'connections.list'));
      if (LISTS_NO_CONNECTION_STATS_OFF.has(rec.key)) {
        expect(connections, rec.key).toEqual([]);
      } else {
        expect(connections, rec.key).toHaveLength(1);
        expect(Object.keys(connections[0] ?? {}).sort(), rec.key).toEqual([
          'name',
          'node',
          'user',
          'vhost',
        ]);
      }
      const totals = (
        jsonOf(rec, 'overview.get') as {
          object_totals: { connections: number };
        }
      ).object_totals;
      expect(totals.connections, rec.key).toBe(1);
    }
  });

  it('with statistics on, every queue carries its policy fields on every release', () => {
    for (const rec of STATS_ON) {
      for (const queue of itemsOf(jsonOf(rec, 'queues.list'))) {
        expect(queue, `${rec.key} ${String(queue.name)}`).toHaveProperty(
          'effective_policy_definition',
        );
        expect(queue, `${rec.key} ${String(queue.name)}`).toHaveProperty(
          'policy',
        );
        expect(queue, `${rec.key} ${String(queue.name)}`).toHaveProperty(
          'operator_policy',
        );
      }
    }
  });
});

describe('OQ-433 which lists the broker pages', () => {
  // The lists that answer the paged envelope when asked for `page`: the same on every RabbitMQ
  // release. Every other list is a bare array, so `page_size` bounds nothing there.
  const ENVELOPE = [
    'channels.list',
    'connections.list',
    'exchanges.inVhost',
    'exchanges.list',
    'queues.inVhost',
    'queues.list',
    'users.list',
  ];
  const PAGED_BY_ADAPTER = ENDPOINTS.filter((spec) => spec.paged).map(
    (spec) => spec.id,
  );
  // The one RabbitMQ release that takes `page` on /api/vhosts, and LavinMQ.
  const ACCEPTS_PAGE_ON_VHOSTS = new Set([
    '3.13.7/stats-on',
    '3.13.7/stats-off',
    LAVINMQ,
  ]);

  it('RabbitMQ pages exactly these lists, on every release and with statistics on and off', () => {
    for (const rec of RABBITMQ) {
      const seen = rec.manifest.entries
        .filter(
          (entry) =>
            entry.kind === 'endpoint' &&
            entry.status === 200 &&
            PAGED_BY_ADAPTER.includes(entry.id),
        )
        .filter((entry) => entry.envelope === true)
        .map((entry) => entry.id)
        .sort();
      // The channel list is refused with statistics off before 4.3.6, so it answers no page.
      const answered = ENVELOPE.filter((id) => entryOf(rec, id).status === 200);
      expect(seen, rec.key).toEqual(answered.sort());
    }
  });

  it('LavinMQ pages every list the adapter pages, except the ones it has no such endpoint for', () => {
    const rec = recording(LAVINMQ);
    for (const id of PAGED_BY_ADAPTER) {
      const entry = entryOf(rec, id);
      expect(entry.status, id).toBe(200);
      expect(entry.envelope, id).toBe(true);
    }
  });

  it('/api/vhosts refuses `page` on every release after 3.13.7, so the adapter does not send it', () => {
    expect(PAGED_BY_ADAPTER).not.toContain('vhosts.list');
    for (const rec of MGMT) {
      const entry = entryOf(rec, 'vhosts.list');
      expect(entry.sent, rec.key).toBe('/api/vhosts');
      expect(entry.status, rec.key).toBe(200);
      expect(Array.isArray(jsonOf(rec, 'vhosts.list')), rec.key).toBe(true);
      const probe = entryOf(rec, 'error.vhosts-paged');
      expect(probe.sent, rec.key).toBe('/api/vhosts?page=1&page_size=100');
      expect(probe.status, rec.key).toBe(
        ACCEPTS_PAGE_ON_VHOSTS.has(rec.key) ? 200 : 500,
      );
    }
  });
});

describe('401 texts (OQ-412)', () => {
  it('a login that fails is not_authorized, and a user without a management tag says so', () => {
    for (const rec of RABBITMQ) {
      for (const id of ['error.wrong-password', 'error.unknown-user']) {
        expect(jsonOf(rec, id), `${rec.key} ${id}`).toEqual({
          error: 'not_authorized',
          reason: 'Not_Authorized',
        });
      }
      expect(jsonOf(rec, 'error.no-management-tag'), rec.key).toEqual({
        error: 'not_authorised',
        reason: 'Not management user',
      });
      expect(jsonOf(rec, 'error.queue-not-found'), rec.key).toEqual({
        error: 'Object Not Found',
        reason: 'Not Found',
      });
    }
  });
});

describe('Prometheus pages', () => {
  const SAMPLE =
    /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+(-?\d+))?$/;
  const NUMBER =
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$|^(?:[+-]?Inf|NaN)$/;

  function parse(text: string): {
    families: Map<string, string>;
    samples: { name: string; labels: string; value: string }[];
  } {
    const families = new Map<string, string>();
    const samples: { name: string; labels: string; value: string }[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '') continue;
      if (line.startsWith('# TYPE ')) {
        const [, , name, kind] = line.split(/\s+/);
        families.set(name ?? '', kind ?? '');
      } else if (!line.startsWith('#')) {
        const match = SAMPLE.exec(line);
        if (match === null) throw new Error(`not a sample line: ${line}`);
        samples.push({
          name: match[1] ?? '',
          labels: match[2] ?? '',
          value: match[3] ?? '',
        });
      }
    }
    return { families, samples };
  }

  it('every page of every recording is Prometheus text: typed families, well-formed samples, numeric values', () => {
    for (const rec of PROMETHEUS) {
      for (const entry of rec.manifest.entries) {
        expect(entry.status, `${rec.key} ${entry.id}`).toBe(200);
        const { families, samples } = parse(textOf(rec, entry));
        expect(families.size, `${rec.key} ${entry.id}`).toBeGreaterThan(5);
        expect(samples.length, `${rec.key} ${entry.id}`).toBeGreaterThan(5);
        for (const sample of samples) {
          expect(sample.value, `${rec.key} ${entry.id} ${sample.name}`).toMatch(
            NUMBER,
          );
        }
      }
    }
  });

  it('each page names the product and the version that served it', () => {
    for (const rec of PROMETHEUS) {
      const { samples } = parse(
        textOf(rec, entryOf(rec, 'prometheus.metrics')),
      );
      const identity = samples.find((sample) =>
        sample.name.endsWith('_identity_info'),
      );
      expect(identity, rec.key).toBeDefined();
      if (rec.manifest.product === 'lavinmq') {
        expect(identity?.name).toBe('lavinmq_identity_info');
        expect(identity?.labels).toContain('lavinmq_version="2.10.2"');
      } else {
        expect(identity?.name).toBe('rabbitmq_identity_info');
        expect(identity?.labels).toContain('rabbitmq_node="rabbit@lab-node"');
        expect(
          samples.some((sample) => sample.name === 'rabbitmq_queues'),
          rec.key,
        ).toBe(true);
      }
    }
  });

  it('the per-queue page carries the families asked for on RabbitMQ', () => {
    for (const rec of PROMETHEUS.filter(
      (candidate) => candidate.manifest.product === 'rabbitmq',
    )) {
      const { families } = parse(
        textOf(rec, entryOf(rec, 'prometheus.detailed-queues')),
      );
      expect(
        families.has('rabbitmq_detailed_queue_messages_ready'),
        rec.key,
      ).toBe(true);
      expect(families.has('rabbitmq_detailed_queue_consumers'), rec.key).toBe(
        true,
      );
    }
  });
});
