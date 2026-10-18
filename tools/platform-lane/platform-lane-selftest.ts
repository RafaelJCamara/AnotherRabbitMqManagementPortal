// Self-test of the platform upgrade lane (M0-76, A-25). Run with
//   node --test tools/platform-lane/platform-lane-selftest.ts
// Test names quote the acceptance criterion they prove:
//   AC-1  Given a new Angular/Node/Electron major, a platform-lane issue is opened automatically.
// plus the constraints the lane inherits (release-age gate, least privilege, Renovate parity).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe as suite, it as spec } from 'node:test';
import { parse } from 'yaml';
import { detect } from './detect.ts';
import type { DetectContext, Plan } from './detect.ts';
import {
  ADR_ITEM,
  CHECKLIST,
  LABELS,
  marker,
  parsePlan,
  renderBody,
  renderReport,
  splitTracked,
  title,
} from './issue.ts';
import { parseManifest, readPinSources, resolvePins } from './manifest.ts';
import type { Manifest } from './manifest.ts';
import {
  httpRegistry,
  nodeReleases,
  npmReleases,
  versionDocFrom,
} from './registry.ts';
import type { Registry, Release, VersionDoc } from './registry.ts';
import { parseVersion, satisfies } from './semver.ts';

// node:test registers asynchronously and returns a promise nobody needs; `void` says so once.
function describe(name: string, body: () => void): void {
  void suite(name, body);
}
function it(name: string, run: () => void | Promise<void>): void {
  void spec(name, run);
}

const here = import.meta.dirname;
const root = resolve(here, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const manifestText = readFileSync(join(here, 'platforms.json'), 'utf8');

const DAY = 86_400_000;
const NOW = new Date('2026-10-18T12:00:00.000Z');
const AGE_GATE = 4320; // minutes, as in pnpm-workspace.yaml
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ---- fakes ----------------------------------------------------------------------------------

function release(
  version: string,
  published: Date,
  lts: string | null = null,
): Release {
  return { version, published, lts };
}

function doc(
  version: string,
  extra: {
    engines?: Record<string, string>;
    peers?: Record<string, string>;
  } = {},
): VersionDoc {
  return {
    version,
    engines: extra.engines ?? {},
    peerDependencies: extra.peers ?? {},
  };
}

interface FakeData {
  releases: Record<string, Release[]>;
  docs: Record<string, VersionDoc>;
  failing?: string[];
}

function fakeRegistry(data: FakeData): Registry {
  return {
    releases(platform) {
      if (data.failing?.includes(platform.id) === true)
        return Promise.reject(new Error(`registry down for ${platform.id}`));
      return Promise.resolve(data.releases[platform.id] ?? []);
    },
    versionDoc(name, ref) {
      return Promise.resolve(data.docs[`${name}@${ref}`] ?? null);
    },
  };
}

/** The pins of this repository at the time of writing: Angular 22, Node 24, TypeScript 6, ... */
const PIN_SOURCES = {
  catalog: {
    nx: '23.3.0',
    '@angular/core': '22.2.3',
    typescript: '6.0.3',
    vitest: '5.0.5',
    eslint: '10.12.0',
  },
  nvmrc: '24.22.0\n',
  packageManager: 'pnpm@12.14.0',
};

function context(
  data: FakeData,
  overrides: Partial<DetectContext> = {},
): DetectContext {
  const manifest = parseManifest(manifestText);
  return {
    manifest,
    pins: resolvePins(manifest, PIN_SOURCES),
    catalog: PIN_SOURCES.catalog,
    registry: fakeRegistry(data),
    now: NOW,
    ageGateMinutes: AGE_GATE,
    ...overrides,
  };
}

async function planFor(data: FakeData, overrides: Partial<DetectContext> = {}) {
  return detect(context(data, overrides));
}

// ---- semver ---------------------------------------------------------------------------------

describe('semver subset', () => {
  it('parses exact stable versions only', () => {
    assert.deepEqual(parseVersion('22.2.3'), { major: 22, minor: 2, patch: 3 });
    assert.deepEqual(parseVersion('v26.12.0'), {
      major: 26,
      minor: 12,
      patch: 0,
    });
    assert.equal(parseVersion('7.0.1-rc'), null);
    assert.equal(parseVersion('7.0'), null);
    assert.equal(parseVersion('latest'), null);
  });

  it('reads the ranges the platform packages publish', () => {
    // @angular/core engines.node, @angular/compiler-cli peer typescript, @nx/angular peer, eslint.
    const node = '^22.22.3 || ^24.15.0 || >=26.0.0';
    assert.equal(satisfies('24.22.0', node), true);
    assert.equal(satisfies('26.12.0', node), true);
    assert.equal(satisfies('24.14.0', node), false);
    assert.equal(satisfies('25.1.0', node), false);
    assert.equal(satisfies('6.0.3', '>=6.0 <6.1'), true);
    assert.equal(satisfies('7.0.2', '>=6.0 <6.1'), false);
    assert.equal(satisfies('22.2.3', '>= 20.0.0 < 23.0.0'), true);
    assert.equal(satisfies('23.0.0', '>= 20.0.0 < 23.0.0'), false);
    assert.equal(satisfies('10.12.0', '^9.0.0 || ^10.0.0'), true);
    assert.equal(satisfies('11.0.0', '^9.0.0 || ^10.0.0'), false);
    assert.equal(satisfies('24.22.0', '>=18.*'), true);
    assert.equal(satisfies('6.0.3', '*'), true);
  });

  it('handles caret, tilde, x-ranges and hyphen ranges', () => {
    assert.equal(satisfies('1.2.9', '^1.2.3'), true);
    assert.equal(satisfies('2.0.0', '^1.2.3'), false);
    assert.equal(satisfies('0.2.5', '^0.2.3'), true);
    assert.equal(satisfies('0.3.0', '^0.2.3'), false);
    assert.equal(satisfies('0.0.4', '^0.0.3'), false);
    assert.equal(satisfies('1.2.9', '~1.2.3'), true);
    assert.equal(satisfies('1.3.0', '~1.2.3'), false);
    assert.equal(satisfies('1.9.0', '1.x'), true);
    assert.equal(satisfies('2.0.0', '1.x'), false);
    assert.equal(satisfies('1.2.7', '1.2'), true);
    assert.equal(satisfies('1.3.0', '1.2'), false);
    assert.equal(satisfies('2.3.9', '1.2.3 - 2.3.4'), false);
    assert.equal(satisfies('2.3.4', '1.2.3 - 2.3.4'), true);
    assert.equal(satisfies('1.2.5', '>1.2'), false);
    assert.equal(satisfies('1.3.0', '>1.2'), true);
    assert.equal(satisfies('1.2.9', '<=1.2'), true);
    assert.equal(satisfies('1.3.0', '<=1.2'), false);
  });

  it('answers null for a range it cannot read, never a guess', () => {
    assert.equal(satisfies('1.0.0', 'github:foo/bar'), null);
    assert.equal(satisfies('1.0.0', '^1.0.0 || not-a-range'), null);
    assert.equal(satisfies('not-a-version', '^1.0.0'), null);
  });
});

// ---- manifest and pins ----------------------------------------------------------------------

describe('manifest and pins', () => {
  it('the shipped platforms.json is valid and names the whole pinned set', () => {
    const ids = parseManifest(manifestText).platforms.map((p) => p.id);
    for (const id of [
      'node',
      'pnpm',
      'nx',
      'angular',
      'typescript',
      'vitest',
      'eslint',
      'electron',
      'fastify',
    ]) {
      assert.ok(ids.includes(id), `platforms.json lacks ${id}`);
    }
  });

  it('resolves every pin of this repository from the real files', () => {
    const manifest = parseManifest(manifestText);
    const sources = readPinSources(
      read('pnpm-workspace.yaml'),
      read('.nvmrc'),
      read('package.json'),
    );
    const pins = resolvePins(manifest, sources);
    assert.equal(pins.node?.source, '.nvmrc');
    assert.equal(pins.pnpm?.source, 'packageManager');
    for (const id of ['nx', 'angular', 'typescript', 'vitest', 'eslint']) {
      assert.equal(
        pins[id]?.source,
        'catalog',
        `${id} should come from the catalog`,
      );
    }
    assert.equal(pins.angular?.version, sources.catalog['@angular/core']);
  });

  it('uses the planned pin of a platform that is not installed yet, and the catalog once it is', () => {
    const manifest = parseManifest(manifestText);
    const before = resolvePins(manifest, PIN_SOURCES);
    assert.deepEqual(before.electron, {
      version: '44.8.0',
      source: 'fallback',
    });
    assert.deepEqual(before.fastify, { version: '5.12.7', source: 'fallback' });
    const after = resolvePins(manifest, {
      ...PIN_SOURCES,
      catalog: { ...PIN_SOURCES.catalog, electron: '45.0.1' },
    });
    assert.deepEqual(after.electron, { version: '45.0.1', source: 'catalog' });
  });

  it('refuses a pin that is a range or missing', () => {
    const manifest = parseManifest(manifestText);
    assert.throws(
      () =>
        resolvePins(manifest, {
          ...PIN_SOURCES,
          catalog: { ...PIN_SOURCES.catalog, nx: '^23.3.0' },
        }),
      /nx: pin "\^23\.3\.0" \(catalog\) is not an exact/,
    );
    assert.throws(
      () =>
        resolvePins(manifest, { ...PIN_SOURCES, packageManager: 'yarn@4.0.0' }),
      /pnpm: no pin found/,
    );
  });

  it('reports every problem of a broken manifest', () => {
    const broken = record(JSON.parse(manifestText));
    const platforms = (broken.platforms as Record<string, unknown>[]).slice(
      0,
      2,
    );
    platforms[0] = { ...platforms[0], majors: 'some', windowDays: 0 };
    platforms[1] = {
      ...platforms[1],
      checks: [
        {
          id: 'x',
          label: 'x',
          kind: 'peer',
          package: 'p',
          at: 'target',
          subject: { platform: 'nope', version: 'target' },
        },
      ],
    };
    assert.throws(
      () => parseManifest(JSON.stringify({ platforms })),
      (error: Error) =>
        error.message.includes('majors must be') &&
        error.message.includes('windowDays must be') &&
        error.message.includes('a peer check needs "peer"') &&
        error.message.includes('subject.platform is not a platform id'),
    );
  });
});

// ---- registry parsing -----------------------------------------------------------------------

describe('registry data', () => {
  it('keeps stable npm versions with a publish time and drops pre-releases', () => {
    const releases = npmReleases({
      versions: { '23.0.0': {}, '23.1.0-rc.1': {}, '23.0.1': {}, '22.9.9': {} },
      time: {
        '23.0.0': '2026-06-01T10:00:00.000Z',
        '23.1.0-rc.1': '2026-06-20T10:00:00.000Z',
        '22.9.9': 'not a date',
      },
    });
    assert.deepEqual(
      releases.map((r) => r.version),
      ['23.0.0'],
    );
  });

  it('reads Node releases with their date and LTS codename', () => {
    const releases = nodeReleases([
      { version: 'v26.12.0', date: '2026-10-14', lts: false },
      { version: 'v24.22.0', date: '2026-09-01', lts: 'Krypton' },
    ]);
    assert.equal(releases[0]?.version, '26.12.0');
    assert.equal(
      releases[0].published.toISOString(),
      '2026-10-14T00:00:00.000Z',
    );
    assert.equal(releases[0].lts, null);
    assert.equal(releases[1]?.lts, 'Krypton');
  });

  it('turns a registry answer into engines and peers, and a 404 into null', async () => {
    assert.deepEqual(
      versionDocFrom({
        version: '1.0.0',
        engines: { node: '>=1' },
        peerDependencies: { a: '^1' },
      }),
      {
        version: '1.0.0',
        engines: { node: '>=1' },
        peerDependencies: { a: '^1' },
      },
    );
    const urls: string[] = [];
    const registry = httpRegistry((url) => {
      urls.push(url);
      return Promise.reject(new Error(`GET ${url} answered 404`));
    });
    assert.equal(await registry.versionDoc('@angular/core', '99.0.0'), null);
    assert.deepEqual(urls, [
      'https://registry.npmjs.org/@angular%2Fcore/99.0.0',
    ]);
  });
});

// ---- detection ------------------------------------------------------------------------------

const ANGULAR_23 = (published: Date) => [
  release('22.2.3', daysAgo(30)),
  release('23.0.0', published),
];

describe('AC-1 a new major opens a platform-lane issue', () => {
  it('AC-1 Angular: 23.0.0 is a candidate for a repository on 22.2.3', async () => {
    const { plan, reports } = await planFor({
      releases: { angular: ANGULAR_23(daysAgo(10)) },
      docs: {
        '@angular/core@23.0.0': doc('23.0.0', {
          engines: { node: '^24.15.0 || >=26.0.0' },
        }),
        '@angular/compiler-cli@23.0.0': doc('23.0.0', {
          peers: { typescript: '>=6.0 <6.2' },
        }),
        '@nx/angular@latest': doc('23.3.0', {
          peers: { '@angular/build': '>= 20.0.0 < 23.0.0' },
        }),
      },
    });
    assert.equal(plan.candidates.length, 1);
    const [candidate] = plan.candidates;
    assert.equal(candidate?.platform, 'angular');
    assert.equal(candidate.major, 23);
    assert.equal(candidate.version, '23.0.0');
    assert.equal(candidate.pinned, '22.2.3');
    assert.equal(reports.find((r) => r.id === 'angular')?.status, 'candidate');
    // The Nx plugin does not support Angular 23 yet: reported, but it does not hold the issue back.
    const nx = candidate.checks.find((c) => c.id === 'angular-nx');
    assert.equal(nx?.status, 'incompatible');
    assert.equal(nx.blocking, false);
  });

  it('AC-1 Node: 26.12.0 is a candidate for a repository on 24.22.0, and the odd 25 is ignored', async () => {
    const { plan } = await planFor({
      releases: {
        node: [
          release('24.22.0', daysAgo(40)),
          release('25.4.0', daysAgo(20)),
          release('26.0.0', daysAgo(160)),
          release('26.12.0', daysAgo(4)),
        ],
      },
      docs: {
        '@angular/core@22.2.3': doc('22.2.3', {
          engines: { node: '^22.22.3 || ^24.15.0 || >=26.0.0' },
        }),
        'vitest@5.0.5': doc('5.0.5', {
          engines: { node: '^22.12.0 || ^24.0.0 || >=26.0.0' },
        }),
        'eslint@10.12.0': doc('10.12.0', {
          engines: { node: '^20.19.0 || ^22.13.0 || >=24' },
        }),
        'pnpm@12.14.0': doc('12.14.0', { engines: { node: '>=18.*' } }),
      },
    });
    assert.equal(plan.candidates.length, 1);
    const [candidate] = plan.candidates;
    assert.equal(candidate?.platform, 'node');
    assert.equal(candidate.major, 26);
    assert.equal(candidate.version, '26.12.0');
    assert.equal(candidate.ga, daysAgo(160).toISOString());
    assert.deepEqual(
      candidate.checks.map((c) => c.status),
      ['ok', 'ok', 'ok', 'ok'],
    );
  });

  it('AC-1 Electron: 45.0.0 is a candidate, due four weeks after GA', async () => {
    const { plan } = await planFor({
      releases: {
        electron: [
          release('44.9.0', daysAgo(5)),
          release('45.0.0', daysAgo(6)),
        ],
      },
      docs: {},
    });
    assert.equal(plan.candidates.length, 1);
    const [candidate] = plan.candidates;
    assert.equal(candidate?.platform, 'electron');
    assert.equal(candidate.major, 45);
    assert.equal(
      candidate.due,
      new Date(daysAgo(6).getTime() + 28 * DAY).toISOString(),
    );
  });

  it('AC-1 opens one candidate per platform and says nothing for a platform that is current', async () => {
    const { plan, reports } = await planFor({
      releases: {
        angular: ANGULAR_23(daysAgo(10)),
        electron: [release('45.0.0', daysAgo(10))],
        node: [release('26.12.0', daysAgo(10))],
        nx: [release('23.4.0', daysAgo(1))],
      },
      docs: {},
    });
    assert.deepEqual(plan.candidates.map((c) => c.platform).sort(), [
      'angular',
      'electron',
      'node',
    ]);
    assert.equal(reports.find((r) => r.id === 'nx')?.status, 'current');
  });
});

describe('release-age gate', () => {
  it('does not propose a major younger than minimumReleaseAge, and says when it becomes eligible', async () => {
    const { plan, reports } = await planFor({
      releases: {
        angular: ANGULAR_23(new Date(NOW.getTime() - 3 * DAY + 60_000)),
      },
      docs: {},
    });
    assert.equal(plan.candidates.length, 0);
    const angular = reports.find((r) => r.id === 'angular');
    assert.equal(angular?.status, 'aging');
    assert.equal(angular.newest?.version, '23.0.0');
    assert.equal(
      angular.eligibleAt,
      new Date(NOW.getTime() + 60_000).toISOString(),
    );
  });

  it('proposes a major exactly at the gate', async () => {
    const { plan } = await planFor({
      releases: {
        angular: ANGULAR_23(new Date(NOW.getTime() - AGE_GATE * 60_000)),
      },
      docs: {},
    });
    assert.equal(plan.candidates.length, 1);
  });

  it('targets the newest version old enough, not a younger patch of the same major', async () => {
    const { plan } = await planFor({
      releases: {
        angular: [
          release('23.0.0', daysAgo(20)),
          release('23.0.2', daysAgo(5)),
          release('23.0.3', daysAgo(1)),
        ],
      },
      docs: {},
    });
    assert.equal(plan.candidates[0]?.version, '23.0.2');
  });

  it('falls back to the older major when only the newest one is still too young', async () => {
    const { plan } = await planFor({
      releases: {
        angular: [
          release('23.0.0', daysAgo(40)),
          release('24.0.0', daysAgo(1)),
        ],
      },
      docs: {},
    });
    assert.equal(plan.candidates[0]?.major, 23);
  });

  it('uses the gate it is given, so loosening the workspace key cannot be done here', async () => {
    const releases = { angular: ANGULAR_23(daysAgo(10)) };
    const strict = await planFor(
      { releases, docs: {} },
      { ageGateMinutes: 20 * 1440 },
    );
    assert.equal(strict.plan.candidates.length, 0);
  });
});

describe('what is not a new major', () => {
  it('ignores minor and patch releases of the pinned major', async () => {
    const { plan, reports } = await planFor({
      releases: {
        angular: [
          release('22.2.3', daysAgo(30)),
          release('22.3.0', daysAgo(10)),
          release('22.3.1', daysAgo(9)),
        ],
      },
      docs: {},
    });
    assert.equal(plan.candidates.length, 0);
    assert.equal(reports.find((r) => r.id === 'angular')?.status, 'current');
  });

  it('ignores a major lower than the pin', async () => {
    const { plan } = await planFor({
      releases: { angular: [release('21.9.9', daysAgo(30))] },
      docs: {},
    });
    assert.equal(plan.candidates.length, 0);
  });
});

describe('compatibility checks', () => {
  const TS7 = {
    releases: {
      typescript: [release('6.0.3', daysAgo(90)), release('7.0.2', daysAgo(8))],
    },
  };

  it('defers TypeScript 7 while the latest Angular compiler does not accept it', async () => {
    const { plan, reports } = await planFor({
      ...TS7,
      docs: {
        '@angular/compiler-cli@latest': doc('22.2.3', {
          peers: { typescript: '>=6.0 <6.1' },
        }),
        'typescript-eslint@latest': doc('8.71.2', {
          peers: { typescript: '>=4.8.4 <6.1.0' },
        }),
      },
    });
    assert.equal(plan.candidates.length, 0);
    const ts = reports.find((r) => r.id === 'typescript');
    assert.equal(ts?.status, 'deferred');
    assert.match(ts.candidate?.checks[0]?.detail ?? '', /outside it/);
  });

  it('opens the TypeScript issue once Angular accepts it, even if typescript-eslint does not yet', async () => {
    const { plan } = await planFor({
      ...TS7,
      docs: {
        '@angular/compiler-cli@latest': doc('23.0.0', {
          peers: { typescript: '>=6.0 <7.1' },
        }),
        'typescript-eslint@latest': doc('8.71.2', {
          peers: { typescript: '>=4.8.4 <6.1.0' },
        }),
      },
    });
    assert.equal(plan.candidates.length, 1);
    assert.deepEqual(
      plan.candidates[0]?.checks.map((c) => [c.id, c.status]),
      [
        ['typescript-angular', 'ok'],
        ['typescript-eslint', 'incompatible'],
      ],
    );
  });

  it('treats metadata it cannot find as unknown, which never blocks', async () => {
    const { plan } = await planFor({ ...TS7, docs: {} });
    assert.equal(
      plan.candidates.length,
      0,
      'the blocking check is not ok, so TypeScript waits',
    );
    const unblocked = await planFor({
      releases: { angular: ANGULAR_23(daysAgo(10)) },
      docs: {},
    });
    assert.equal(unblocked.plan.candidates.length, 1);
    assert.ok(
      unblocked.plan.candidates[0]?.checks.every((c) => c.status === 'unknown'),
    );
  });

  it('reads the peer range of the right package at the right version', async () => {
    const { plan } = await planFor({
      releases: {
        eslint: [
          release('10.12.0', daysAgo(90)),
          release('11.0.0', daysAgo(9)),
        ],
      },
      docs: {
        'eslint@11.0.0': doc('11.0.0', {
          engines: { node: '^22.13.0 || >=24' },
        }),
        'typescript-eslint@latest': doc('9.0.0', {
          peers: { eslint: '^9.0.0 || ^10.0.0 || ^11.0.0' },
        }),
        '@nx/eslint@latest': doc('23.3.0', {
          peers: { eslint: '^9.0.0 || ^10.0.0' },
        }),
      },
    });
    const byId = Object.fromEntries(
      (plan.candidates[0]?.checks ?? []).map((c) => [c.id, c.status]),
    );
    assert.deepEqual(byId, {
      'eslint-node': 'ok',
      'eslint-typescript-eslint': 'ok',
      'eslint-nx': 'incompatible',
      'eslint-angular': 'unknown',
    });
  });
});

describe('failures are loud', () => {
  it('reports a platform whose registry lookup failed and still evaluates the others', async () => {
    const { plan, reports } = await planFor({
      releases: { angular: ANGULAR_23(daysAgo(10)) },
      docs: {},
      failing: ['node'],
    });
    assert.equal(reports.find((r) => r.id === 'node')?.status, 'error');
    assert.match(
      reports.find((r) => r.id === 'node')?.error ?? '',
      /registry down for node/,
    );
    assert.equal(plan.candidates.length, 1);
  });
});

// ---- issue text -----------------------------------------------------------------------------

async function nodeCandidate() {
  const { plan } = await planFor({
    releases: { node: [release('26.12.0', daysAgo(10))] },
    docs: {},
  });
  const candidate = plan.candidates[0];
  assert.ok(candidate);
  return { plan, candidate };
}

describe('issue text', () => {
  it('carries the marker, the labels, the facts and the runbook checklist', async () => {
    const { candidate } = await nodeCandidate();
    const body = renderBody(candidate, AGE_GATE);
    assert.equal(title(candidate), '[Platform] Node 26: upgrade from 24.22.0');
    assert.deepEqual([...LABELS], ['lane:platform', 'type:chore']);
    assert.ok(body.startsWith(`${marker('node', 26)}\n`));
    assert.match(body, /26\.12\.0 was published on 2026-10-08/);
    assert.match(body, /at least 3 days old/);
    for (const item of CHECKLIST)
      assert.ok(body.includes(`- [ ] ${item}`), item);
    assert.ok(!body.includes(ADR_ITEM), 'Node is not ADR-gated');
  });

  it('adds the ADR item to the ADR-gated platforms (Nx, fastify) and only to them', async () => {
    const { plan } = await planFor({
      releases: {
        nx: [release('24.0.0', daysAgo(10))],
        fastify: [release('6.0.0', daysAgo(10))],
        vitest: [release('6.0.0', daysAgo(10))],
      },
      docs: {},
    });
    const gated = Object.fromEntries(
      plan.candidates.map((c) => [
        c.platform,
        renderBody(c, AGE_GATE).includes(ADR_ITEM),
      ]),
    );
    assert.deepEqual(gated, { nx: true, vitest: false, fastify: true });
  });

  it('escapes registry text so a detail cannot break the table or inject markup', async () => {
    const { candidate } = await nodeCandidate();
    const hostile = {
      ...candidate,
      checks: [
        {
          id: 'x',
          label: 'a | b',
          status: 'unknown' as const,
          blocking: false,
          detail: '<img src=x onerror=alert(1)> | row\nbreak',
        },
      ],
    };
    const body = renderBody(hostile, AGE_GATE);
    assert.ok(!body.includes('<img'));
    assert.match(
      body,
      /\| a \\\| b \| unknown \| &lt;img src=x onerror=alert\(1\)&gt; \\\| row break \|/,
    );
  });

  it('keeps the issue template in step with the checklist', () => {
    const template = record(
      parse(read('.github/ISSUE_TEMPLATE/platform_upgrade.yml')),
    );
    assert.deepEqual(template.labels, [...LABELS]);
    const checkboxes = (template.body as Record<string, unknown>[]).find(
      (b) => b.type === 'checkboxes',
    );
    const options = (
      record(checkboxes?.attributes).options as { label: string }[]
    ).map((o) => o.label);
    assert.deepEqual(options, [ADR_ITEM, ...CHECKLIST]);
  });

  it('the report lists every platform, with the reason for a deferral', async () => {
    const { plan, reports } = await planFor({
      releases: {
        typescript: [release('7.0.2', daysAgo(8))],
        node: [release('26.12.0', daysAgo(1))],
      },
      docs: {
        '@angular/compiler-cli@latest': doc('22.2.3', {
          peers: { typescript: '>=6.0 <6.1' },
        }),
      },
    });
    const text = renderReport(reports, plan);
    for (const r of reports) assert.ok(text.includes(`| ${r.name} |`), r.name);
    assert.match(text, /TypeScript \| 6\.0\.3 \| 7\.0\.2 \| deferred/);
    assert.match(
      text,
      /Node \| 24\.22\.0 \| 26\.12\.0 \| waiting for release age \| eligible from 2026-10-20/,
    );
    assert.match(
      text,
      /Electron \| 44\.8\.0 \| none \| current \| planned pin, not installed yet/,
    );
  });
});

// ---- plan validation and de-duplication -----------------------------------------------------

describe('plan hand-over between the jobs', () => {
  it('round-trips a plan and rejects anything malformed', async () => {
    const { plan, candidate } = await nodeCandidate();
    assert.deepEqual(parsePlan(JSON.stringify(plan)), plan);
    const mutate = (change: (c: Record<string, unknown>) => void): string => {
      const copy = JSON.parse(JSON.stringify(plan)) as Plan & {
        candidates: Record<string, unknown>[];
      };
      change(copy.candidates[0] ?? {});
      return JSON.stringify(copy);
    };
    assert.throws(() => parsePlan('{'), /not JSON/);
    assert.throws(() => parsePlan('{}'), /generatedAt/);
    assert.throws(
      () => parsePlan(mutate((c) => (c.platform = 'Node; rm -rf'))),
      /platform must be a slug/,
    );
    assert.throws(
      () => parsePlan(mutate((c) => (c.version = '26.12.0-rc.1'))),
      /version must be x\.y\.z/,
    );
    assert.throws(
      () => parsePlan(mutate((c) => (c.published = 'yesterday'))),
      /published must be an ISO/,
    );
    assert.throws(
      () => parsePlan(mutate((c) => (c.name = 'x'.repeat(41)))),
      /name is invalid/,
    );
    assert.throws(
      () => parsePlan(mutate((c) => (c.lts = 'a b'))),
      /lts must be/,
    );
    assert.throws(
      () =>
        parsePlan(
          mutate(
            (c) =>
              (c.checks = [
                {
                  id: 'a',
                  label: 'l',
                  detail: 'd',
                  status: 'fine',
                  blocking: false,
                },
              ]),
          ),
        ),
      /status is invalid/,
    );
    assert.ok(candidate);
  });

  it('does not open an issue twice: an open or a closed one with the marker counts', async () => {
    const { candidate } = await nodeCandidate();
    const body = renderBody(candidate, AGE_GATE);
    const other = {
      number: 1,
      state: 'OPEN',
      title: 'unrelated',
      body: 'no marker',
    };
    assert.deepEqual(splitTracked([candidate], [other]).toOpen, [candidate]);
    for (const state of ['OPEN', 'CLOSED']) {
      const result = splitTracked(
        [candidate],
        [other, { number: 9, state, title: 't', body }],
      );
      assert.deepEqual(result.toOpen, []);
      assert.equal(result.tracked[0]?.issue.number, 9);
    }
    // Node 28 is a new question even though Node 26 is tracked.
    const next = { ...candidate, major: 28, version: '28.1.0' };
    assert.deepEqual(
      splitTracked([next], [{ number: 9, state: 'CLOSED', title: 't', body }])
        .toOpen,
      [next],
    );
  });

  it('the CLI refuses a missing or invalid plan before it touches GitHub', () => {
    const run = (args: string[], env: Record<string, string> = {}) => {
      try {
        execFileSync(
          process.execPath,
          [join(here, 'run-platform-lane.ts'), ...args],
          {
            env: { ...process.env, ...env },
            stdio: 'pipe',
          },
        );
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    assert.equal(run(['open', '--dry-run']), 1);
    assert.equal(
      run(['open', '--plan-env=PLAN', '--dry-run'], { PLAN: '{"nope":1}' }),
      1,
    );
    assert.equal(run(['frobnicate']), 1);
  });
});

// ---- the workflow and Renovate stay inside the repository's rules ---------------------------

describe('workflow', () => {
  const workflow = record(
    parse(read('.github/workflows/platform-upgrade-lane.yml')),
  );
  const jobs = record(workflow.jobs);
  const on = record(workflow.on);

  it('runs on a schedule and by hand, and never on a pull request or push', () => {
    assert.ok(Array.isArray(on.schedule));
    assert.ok('workflow_dispatch' in on);
    assert.ok(
      !('pull_request' in on) &&
        !('push' in on) &&
        !('pull_request_target' in on),
    );
  });

  it('starts from no permissions; only the open job may write, and only issues', () => {
    assert.deepEqual(workflow.permissions, {});
    assert.deepEqual(record(jobs.detect).permissions, { contents: 'read' });
    assert.deepEqual(record(jobs.open).permissions, {
      contents: 'read',
      issues: 'write',
    });
  });

  it('checks out without persisting credentials and pins every action by SHA', () => {
    const text = read('.github/workflows/platform-upgrade-lane.yml');
    for (const job of Object.values(jobs)) {
      const steps = record(job).steps as Record<string, unknown>[];
      for (const step of steps) {
        const uses = step.uses;
        if (typeof uses !== 'string' || uses.startsWith('./')) continue;
        assert.match(uses, /@[0-9a-f]{40}$/, `${uses} must be pinned by SHA`);
        if (uses.startsWith('actions/checkout@'))
          assert.equal(record(step.with)['persist-credentials'], false);
      }
    }
    assert.ok(
      !/\$\{\{[^}]*\}\}/.test(runScripts(jobs)),
      'no expression is interpolated into a run script',
    );
    assert.match(
      text,
      /default: true/,
      'a manual run is a dry run unless asked otherwise',
    );
  });
});

function runScripts(jobs: Record<string, unknown>): string {
  return Object.values(jobs)
    .flatMap((job) => record(job).steps as Record<string, unknown>[])
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .join('\n');
}

describe('Renovate parity', () => {
  const renovate = record(JSON.parse(read('renovate.json')));
  const rules = (renovate.packageRules as Record<string, unknown>[]).map((r) =>
    record(r),
  );
  const manifest: Manifest = parseManifest(manifestText);

  it('keeps the release-age gate the workspace enforces', () => {
    assert.equal(renovate.minimumReleaseAge, '3 days');
    assert.equal(
      record(parse(read('pnpm-workspace.yaml'))).minimumReleaseAge,
      3 * 1440,
    );
  });

  it('has one lane-labelled group per platform, listing exactly the manifest packages', () => {
    for (const platform of manifest.platforms) {
      const rule = rules.find(
        (r) => r.groupName === platform.renovate.groupName,
      );
      assert.ok(
        rule,
        `renovate.json has no group "${platform.renovate.groupName}"`,
      );
      assert.deepEqual(
        [...(rule.matchPackageNames as string[])].sort(),
        [...platform.renovate.packages].sort(),
        platform.id,
      );
      assert.ok(
        (rule.addLabels as string[]).includes('lane:platform'),
        platform.id,
      );
    }
  });

  it('sends platform majors to the dashboard instead of an unattended pull request', () => {
    const majors = rules.find((r) => Array.isArray(r.matchUpdateTypes));
    assert.ok(majors, 'renovate.json needs a rule for platform majors');
    assert.deepEqual(majors.matchUpdateTypes, ['major']);
    assert.equal(majors.dependencyDashboardApproval, true);
    assert.deepEqual(
      [...(majors.matchPackageNames as string[])].sort(),
      manifest.platforms.flatMap((p) => p.renovate.packages).sort(),
    );
  });

  it('says it is inactive until the app is installed', () => {
    assert.match(
      String(renovate.description),
      /INACTIVE until the Renovate GitHub App is installed on the repository \(OQ-43\)/,
    );
  });
});

describe('runbook', () => {
  it('points at the automation, the workflow and the template', () => {
    const runbook = read('docs/runbooks/platform-upgrade-lane.md');
    for (const needle of [
      'platform-upgrade-lane.yml',
      'platform_upgrade.yml',
      'tools/platform-lane',
      'renovate.json',
    ]) {
      assert.ok(
        runbook.includes(needle),
        `the runbook should mention ${needle}`,
      );
    }
  });
});
