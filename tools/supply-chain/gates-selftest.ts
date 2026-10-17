// Self-test for the supply-chain gates (`nx run supply-chain:gates-selftest`).
// `fixtures/clean` must pass every gate. Each directory in `fixtures/violations` overlays one
// planted violation on the clean fixture and lists, in expect.json, the exact rule ids it must
// trigger: the planted rule, and nothing else.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALLOWLIST_RULES } from './allowlist-gate.ts';
import {
  BUNDLED_RULES,
  declaredLicence,
  packageDirOfInput,
  packageNameOfSpecifier,
  packagesFromMetafile,
} from './bundled-packages.ts';
import { runAllGates } from './gates.ts';
import {
  DENIED_PATTERN,
  DEV_ALLOWED,
  DEV_EXCEPTIONS,
  isSatisfied,
  LICENCE_RULES,
  parseSpdx,
  SHIPPED_ALLOWED,
  SHIPPED_EXCEPTIONS,
} from './licence-gate.ts';
import { LOCKFILE_RULES } from './lockfile-gate.ts';
import { PIN_RULES } from './pin-gate.ts';
import { fixtureFile, loadFixtureWorkspace, readJsonList } from './shared.ts';
import type { Licence } from './shared.ts';
import type { PackageJsonReader } from './bundled-packages.ts';

const fixtures = join(import.meta.dirname, 'fixtures');
const cleanDir = join(fixtures, 'clean');
const violationsDir = join(fixtures, 'violations');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function rulesFor(overlay: string | undefined): string[] {
  const ws = loadFixtureWorkspace(cleanDir, overlay);
  // The shipped input is what run-gates.ts builds: a prepared list plus the packages of a metafile.
  const packageJsons = readJson(
    fixtureFile(cleanDir, overlay, 'package-jsons.json'),
  ) as Record<string, Record<string, unknown>>;
  const read: PackageJsonReader = (dir) => packageJsons[dir];
  const bundled = packagesFromMetafile(
    'fixture',
    readJson(fixtureFile(cleanDir, overlay, 'metafile.json')),
    read,
  );
  const violations = runAllGates(ws, {
    licences: readJsonList<Licence>(
      fixtureFile(cleanDir, overlay, 'licences.json'),
    ),
    shipped: [
      ...readJsonList<Licence>(fixtureFile(cleanDir, overlay, 'shipped.json')),
      ...bundled.packages,
    ],
    shippedProblems: bundled.problems,
  });
  return [...new Set(violations.map((v) => v.rule))].sort();
}

const cases = readdirSync(violationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const expect = JSON.parse(
      readFileSync(join(violationsDir, entry.name, 'expect.json'), 'utf8'),
    ) as { rules: string[] };
    return {
      name: entry.name,
      dir: join(violationsDir, entry.name),
      rules: [...expect.rules].sort(),
    };
  });

test('the clean fixture passes every gate', () => {
  assert.deepEqual(rulesFor(undefined), []);
});

for (const c of cases) {
  test(`planted ${c.name} fails with ${c.rules.length === 0 ? 'no rule (negative control)' : c.rules.join(', ')}`, () => {
    assert.deepEqual(rulesFor(c.dir), c.rules);
  });
}

test('the planted violations named by M0-02 each fail with their own rule id', () => {
  const required: Record<string, string> = {
    'git-dependency': 'lockfile.exotic-source',
    'typescript-7': 'pin.typescript-version',
    'types-amqplib': 'ban.types-amqplib',
    'primeng-22': 'ban.primeng',
    'ag-grid-enterprise': 'ban.ag-grid-enterprise',
    apexcharts: 'ban.apexcharts',
    'oasdiff-npm': 'ban.oasdiff-npm',
    'licence-gpl': 'licence.denied',
    'shipped-not-allowed': 'licence.shipped-not-allowed',
    'shipped-metafile-unresolved': 'licence.shipped-unresolved',
    'shipped-metafile-malformed': 'licence.shipped-input',
    'exception-unlogged': 'licence.exception-unlogged',
    'allowlist-missing-entry': 'allowlist.missing-entry',
  };
  for (const [name, rule] of Object.entries(required)) {
    const found = cases.find((c) => c.name === name);
    assert.ok(found, `fixture ${name} is missing`);
    assert.deepEqual(found.rules, [rule], `fixture ${name}`);
  }
  assert.equal(
    new Set(Object.values(required)).size,
    Object.keys(required).length,
    'rule ids must be distinct',
  );
});

test('every gate rule is proven by at least one planted fixture', () => {
  const planted = new Set(cases.flatMap((c) => c.rules));
  const all = [
    ...LICENCE_RULES,
    ...BUNDLED_RULES,
    ...LOCKFILE_RULES,
    ...PIN_RULES,
    ...ALLOWLIST_RULES,
  ];
  const unproven = all.filter((rule) => !planted.has(rule));
  assert.deepEqual(unproven, [], 'rules without a planted fixture');
});

test('SPDX expressions follow AND/OR semantics', () => {
  const shipped = (text: string): boolean =>
    isSatisfied(parseSpdx(text), (id) => SHIPPED_ALLOWED.has(id));
  assert.equal(shipped('MIT'), true);
  assert.equal(shipped('(MPL-2.0 OR Apache-2.0)'), true);
  assert.equal(shipped('MPL-2.0'), false);
  assert.equal(shipped('(Apache-2.0 AND BSD-3-Clause)'), true);
  assert.equal(shipped('(MIT AND GPL-3.0-only)'), false);
  assert.equal(shipped('(MIT OR GPL-3.0-only)'), true);
  assert.equal(shipped('SEE LICENSE IN LICENSE.md'), false);
  assert.equal(shipped('GPL-2.0-only WITH Classpath-exception-2.0'), false);
});

test('the two licence gates are split: dev/build is broader, shipped is exactly DC-50', () => {
  assert.deepEqual([...SHIPPED_ALLOWED].sort(), [
    '0BSD',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    'MIT',
  ]);
  for (const id of SHIPPED_ALLOWED) assert.ok(DEV_ALLOWED.has(id), id);
  assert.ok(DEV_ALLOWED.size > SHIPPED_ALLOWED.size);
  // Tooling-only licences pass the dev/build gate and fail the shipped one.
  for (const id of [
    'CC-BY-4.0',
    'BlueOak-1.0.0',
    'MIT-0',
    'CC0-1.0',
    'MPL-2.0',
  ]) {
    assert.ok(DEV_ALLOWED.has(id), `${id} should be allowed in dev/build`);
    assert.ok(!SHIPPED_ALLOWED.has(id), `${id} must not be allowed in shipped`);
  }
});

test('the hard deny list is never allowed and no exception may carry a denied licence', () => {
  for (const id of [
    'GPL-3.0-only',
    'AGPL-3.0-or-later',
    'SSPL-1.0',
    'BUSL-1.1',
    'Proprietary',
    'UNLICENSED',
  ]) {
    assert.ok(DENIED_PATTERN.test(id), id);
    assert.ok(!DEV_ALLOWED.has(id) && !SHIPPED_ALLOWED.has(id), id);
  }
  for (const e of [...DEV_EXCEPTIONS, ...SHIPPED_EXCEPTIONS]) {
    assert.ok(!DENIED_PATTERN.test(e.license), `${e.name} ${e.license}`);
    assert.notEqual(e.reason.trim(), '', `${e.name} needs a reason`);
  }
});

test('shipped exceptions are a strict subset of the dev/build ones', () => {
  for (const s of SHIPPED_EXCEPTIONS) {
    assert.ok(
      DEV_EXCEPTIONS.some((d) => d.name === s.name && d.license === s.license),
      `${s.name}`,
    );
  }
  assert.ok(DEV_EXCEPTIONS.length > SHIPPED_EXCEPTIONS.length);
});

test('bundled packages come from pnpm paths, scoped names and external imports', () => {
  assert.equal(
    packageDirOfInput(
      'node_modules/.pnpm/@angular+core@22.2.3_x/node_modules/@angular/core/fesm2022/a.mjs',
    ),
    'node_modules/.pnpm/@angular+core@22.2.3_x/node_modules/@angular/core',
  );
  assert.equal(
    packageDirOfInput('node_modules\\rxjs\\dist\\esm\\index.js'),
    'node_modules/rxjs',
  );
  assert.equal(packageDirOfInput('apps/web/src/main.ts'), undefined);
  assert.equal(packageDirOfInput('angular:styles/global:styles'), undefined);
  assert.equal(packageNameOfSpecifier('@scope/name/sub'), '@scope/name');
  assert.equal(packageNameOfSpecifier('rxjs/operators'), 'rxjs');
  for (const builtin of ['node:fs', 'fs', 'path/posix', './x.mjs', '/abs.js'])
    assert.equal(packageNameOfSpecifier(builtin), undefined, builtin);
  assert.equal(declaredLicence({ license: 'MIT' }), 'MIT');
  assert.equal(declaredLicence({ license: { type: 'ISC' } }), 'ISC');
  assert.equal(
    declaredLicence({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }),
    'MIT OR Apache-2.0',
  );
  assert.equal(declaredLicence({ name: 'x' }), 'Unknown');
});
