// The golden-fixture recorder (M0-25): starts a broker, seeds it, asks it every request of the plan
// and keeps what it answered, scrubbed, with a manifest. Nothing here is written by hand; the
// answers are the broker's own (the scrubber only removes secrets and host-specific text).
import { createHash } from 'node:crypto';

import { normaliseGetMessagesBody, shapeRequest } from '@app/adapter-mgmt-http';
import type { Product } from '@app/domain-model';
import { semanticsRegistry } from '@app/semantics';

import { loadBrokerVersions } from '../lab/versions.ts';
import { call, type Login } from './http.ts';
import {
  AFTER_GET,
  ERROR_PROBES,
  PROMETHEUS_PROBES,
  goldenProfile,
  planRequests,
  type Discovered,
  type PlannedRequest,
} from './plan.ts';
import { CANARY_SECRET, createScrubber, findLeaks } from './scrub.ts';
import { applySeed, loadSeed } from './seed.ts';
import { startLavinMq, startRabbitMq, type Session } from './session.ts';
import type {
  FixtureEntry,
  FixtureManifest,
  ProbeAuth,
  QueryValue,
  StatsMode,
} from './types.ts';

export const RECORDER = 'libs/testkit/src/golden';

export interface RecordTarget {
  /** Directory name: the version of a RabbitMQ, `lavinmq-<version>` otherwise. */
  readonly id: string;
  readonly product: Product;
  readonly version: string;
  /** Image without digest. */
  readonly image: string;
  readonly digest: string;
  readonly modes: readonly StatsMode[];
}

/**
 * LavinMQ 2.10.2, pinned by digest (the multi-architecture index of `cloudamqp/lavinmq:2.10.2`
 * read from the registry on 2026-10-19). Bump the digest only with a reviewed change, like
 * `testing/broker-lab/versions.json`.
 */
export const LAVINMQ: RecordTarget = {
  id: 'lavinmq-2.10.2',
  product: 'lavinmq',
  version: '2.10.2',
  image: 'cloudamqp/lavinmq:2.10.2',
  digest:
    'sha256:83c0083744fa619f1c06927618e6f863390bcdebac6de9a0f52173fa69fea9ef',
  modes: ['default'],
};

/** The five lab RabbitMQ versions (statistics on and off) and LavinMQ. */
export function allTargets(): RecordTarget[] {
  return [
    ...loadBrokerVersions().map(
      (broker): RecordTarget => ({
        id: broker.version,
        product: 'rabbitmq',
        version: broker.version,
        image: `rabbitmq:${broker.version}-management`,
        digest: broker.digest,
        modes: ['stats-on', 'stats-off'],
      }),
    ),
    LAVINMQ,
  ];
}

export const dirOf = (
  kind: 'mgmt' | 'prometheus',
  target: Pick<RecordTarget, 'id'>,
  mode: StatsMode,
): string => `${kind}/${target.id}/${mode}`;

export interface Recording {
  readonly target: RecordTarget;
  readonly mode: StatsMode;
  /** Path relative to the fixtures root to file content. */
  readonly files: ReadonlyMap<string, string>;
  readonly mgmt: FixtureManifest;
  readonly prometheus: FixtureManifest;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the statistics show the seeded consumer and counts (or a fixed time with stats off). */
async function settle(session: Session, mode: StatsMode): Promise<void> {
  if (mode === 'stats-off') {
    await sleep(10_000);
    return;
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const reply = await call(
      session.http,
      'GET',
      '/api/queues/golden/golden.classic',
      { login: session.login },
    );
    if (reply.status === 200) {
      const queue = JSON.parse(reply.text) as Record<string, unknown>;
      if (
        Number(queue.consumers ?? 0) >= 1 &&
        Number(queue.messages_unacknowledged ?? 0) >= 2 &&
        Number(queue.messages_ready ?? 0) >= 3
      ) {
        // One more statistics interval, so rates, connections and channels have been published.
        await sleep(7_000);
        return;
      }
    }
    await sleep(1_000);
  }
  throw new Error('the broker never reported the seeded consumer and counts');
}

const loginFor = (session: Session, auth: ProbeAuth): Login => {
  switch (auth) {
    case 'guest':
      return session.login;
    case 'wrong-password':
      return { username: 'guest', password: CANARY_SECRET };
    case 'unknown-user':
      return { username: 'nobody-golden', password: CANARY_SECRET };
    case 'no-management-tag':
      return { username: 'golden-plain', password: CANARY_SECRET };
  }
};

function firstName(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as unknown;
    const items = Array.isArray(body)
      ? body
      : ((body as { items?: unknown[] }).items ?? []);
    const first = items[0] as { name?: unknown } | undefined;
    return typeof first?.name === 'string' ? first.name : undefined;
  } catch {
    return undefined;
  }
}

interface Captured {
  readonly entry: FixtureEntry;
  readonly content: string;
}

export interface RecordDeps {
  readonly start?: (target: RecordTarget, mode: StatsMode) => Promise<Session>;
  readonly log?: (line: string) => void;
}

function defaultStart(target: RecordTarget, mode: StatsMode): Promise<Session> {
  return target.product === 'lavinmq'
    ? startLavinMq(target.image, target.digest)
    : startRabbitMq(target.version, mode);
}

/** Starts a fresh broker for `target` in `mode`, records it, and stops it. */
export async function record(
  target: RecordTarget,
  mode: StatsMode,
  deps: RecordDeps = {},
): Promise<Recording> {
  const log = deps.log ?? (() => undefined);
  const session = await (deps.start ?? defaultStart)(target, mode);
  try {
    log(`  ${target.id} ${mode}: seeding`);
    const loaded = loadSeed();
    const seeded = await applySeed(session, target.product, loaded);
    try {
      await settle(session, mode);
      return await capture(target, mode, session, loaded, seeded.refused, log);
    } finally {
      await seeded.stop();
    }
  } finally {
    await session.stop();
  }
}

async function capture(
  target: RecordTarget,
  mode: StatsMode,
  session: Session,
  loaded: ReturnType<typeof loadSeed>,
  refused: readonly string[],
  log: (line: string) => void,
): Promise<Recording> {
  const scrubber = createScrubber({ hosts: session.hosts });
  const profile = goldenProfile(
    target.product,
    target.version,
    mode === 'stats-off',
  );
  const capability = (id: string, p: typeof profile): boolean =>
    semanticsRegistry.capability(id, p);

  const overview = await call(session.http, 'GET', '/api/overview', {
    login: session.login,
  });
  const reported = JSON.parse(overview.text) as Record<string, unknown>;
  const claimed = reported.rabbitmq_version ?? reported.lavinmq_version;
  const version = typeof claimed === 'string' ? claimed : '';
  if (version !== target.version) {
    throw new Error(
      `the broker reports ${version}, not ${target.version}: the image or the digest is wrong`,
    );
  }

  const found: { connection?: string; channel?: string } = {};
  for (const [key, path] of [
    ['connection', '/api/connections?page=1&page_size=5'],
    ['channel', '/api/channels?page=1&page_size=5'],
  ] as const) {
    const reply = await call(session.http, 'GET', path, {
      login: session.login,
    });
    const name = reply.status === 200 ? firstName(reply.text) : undefined;
    if (name !== undefined) found[key] = name;
  }
  const discovered: Discovered = found;

  const store = (
    id: string,
    kind: FixtureEntry['kind'],
    reply: { status: number; text: string },
    fields: {
      method: 'GET' | 'POST';
      path: string;
      query?: Readonly<Record<string, QueryValue>>;
      body?: unknown;
      sent: string;
      auth: ProbeAuth;
    },
  ): Captured => {
    let parsed: unknown;
    let json = false;
    try {
      parsed = JSON.parse(reply.text);
      json = true;
    } catch {
      // Not JSON: a plain-text error or a Prometheus page; kept as text.
    }
    const ext = json ? 'json' : kind === 'prometheus' ? 'prom' : 'txt';
    const content = json
      ? `${JSON.stringify(scrubber.json(parsed), null, 2)}\n`
      : scrubber.text(reply.text);
    const envelope =
      json &&
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as { items?: unknown }).items) &&
      typeof (parsed as { page?: unknown }).page === 'number';
    return {
      content,
      entry: {
        id,
        kind,
        method: fields.method,
        path: scrubber.path(fields.path),
        ...(fields.query === undefined ? {} : { query: fields.query }),
        ...(fields.body === undefined
          ? {}
          : { body: scrubber.json(fields.body) }),
        sent: scrubber.path(fields.sent),
        auth: fields.auth,
        status: reply.status,
        file: `${id}.${ext}`,
        bytes: Buffer.byteLength(content, 'utf8'),
        ...(json ? { envelope } : {}),
      },
    };
  };

  const captured: Captured[] = [];
  const plan = planRequests(target.product, mode, discovered);
  const send = async (
    id: string,
    kind: 'endpoint' | 'error-probe',
    request: Pick<PlannedRequest, 'method' | 'path' | 'query' | 'body'>,
    auth: ProbeAuth,
  ): Promise<void> => {
    const shaped = shapeRequest(
      request.path,
      request.query,
      profile,
      capability,
    );
    const body =
      request.method === 'POST'
        ? normaliseGetMessagesBody(target.product, request.body)
        : undefined;
    const reply = await call(session.http, request.method, shaped.target, {
      login: loginFor(session, auth),
      ...(body === undefined ? {} : { body }),
    });
    // The recorded `sent` is what the adapter produces for the scrubbed path, so a replay of the
    // manifest through the client asks the same question.
    const scrubbedPath = scrubber.path(request.path);
    const sent = shapeRequest(scrubbedPath, request.query, profile, capability);
    captured.push(
      store(id, kind, reply, {
        method: request.method,
        path: request.path,
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(body === undefined ? {} : { body }),
        sent: sent.target,
        auth,
      }),
    );
  };

  log(
    `  ${target.id} ${mode}: recording ${String(plan.requests.length)} endpoints`,
  );
  for (const request of plan.requests) {
    // Statistics are published on an interval; the counts after a peek are read once it has passed.
    if (request.id === AFTER_GET) await sleep(7_000);
    await send(request.id, 'endpoint', request, 'guest');
  }
  for (const probe of ERROR_PROBES) {
    await send(
      probe.id,
      'error-probe',
      {
        method: 'GET',
        path: probe.path,
        ...(probe.query === undefined ? {} : { query: probe.query }),
      },
      probe.auth,
    );
  }
  const prometheus: Captured[] = [];
  for (const probe of PROMETHEUS_PROBES) {
    const reply = await call(session.prometheus, 'GET', probe.path, {
      accept: 'text/plain',
    });
    prometheus.push(
      store(probe.id, 'prometheus', reply, {
        method: 'GET',
        path: probe.path,
        sent: probe.path,
        auth: 'guest',
      }),
    );
  }

  // Nothing the scrubber should have removed may remain, and no host name may survive.
  for (const { entry, content } of [...captured, ...prometheus]) {
    const leaks = findLeaks(content);
    for (const host of Object.keys(session.hosts)) {
      if (content.includes(host)) leaks.push(`the host name ${host}`);
    }
    if (leaks.length > 0) {
      throw new Error(`${entry.id} still contains: ${leaks.join(', ')}`);
    }
  }

  const common = {
    product: target.product,
    version: target.version,
    image: target.image,
    digest: target.digest,
    stats:
      mode === 'default'
        ? ('n/a' as const)
        : mode === 'stats-on'
          ? ('on' as const)
          : ('off' as const),
    brokerConfig: session.brokerConfig,
    seed: { id: loaded.seed.id, sha256: loaded.sha256, refused },
    recorder: RECORDER,
  };
  const mgmt: FixtureManifest = {
    schema: 1,
    kind: 'mgmt',
    ...common,
    entries: captured.map((item) => item.entry),
    skipped: plan.skipped,
  };
  const prom: FixtureManifest = {
    schema: 1,
    kind: 'prometheus',
    ...common,
    entries: prometheus.map((item) => item.entry),
    skipped: [],
  };

  const files = new Map<string, string>();
  const mgmtDir = dirOf('mgmt', target, mode);
  const promDir = dirOf('prometheus', target, mode);
  files.set(`${mgmtDir}/manifest.json`, `${JSON.stringify(mgmt, null, 2)}\n`);
  files.set(`${promDir}/manifest.json`, `${JSON.stringify(prom, null, 2)}\n`);
  for (const item of captured) {
    files.set(`${mgmtDir}/${item.entry.file}`, item.content);
  }
  for (const item of prometheus) {
    files.set(`${promDir}/${item.entry.file}`, item.content);
  }
  return { target, mode, files, mgmt, prometheus: prom };
}

/** A short digest of a recording's files, for logs. */
export function fingerprint(recording: Recording): string {
  const hash = createHash('sha256');
  for (const [path, content] of [...recording.files].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    hash.update(path).update('\0').update(content).update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}
