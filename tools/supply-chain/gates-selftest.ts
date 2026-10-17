// Self-test for the supply-chain gates (`nx run supply-chain:gates-selftest`).
// `fixtures/clean` must pass every gate. Each directory in `fixtures/violations` overlays one
// planted violation on the clean fixture and lists, in expect.json, the exact rule ids it must
// trigger: the planted rule, and nothing else.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALLOWLIST_RULES } from './allowlist-gate.ts';
import { runAllGates } from './gates.ts';
import {
  isSatisfied,
  LICENCE_RULES,
  parseSpdx,
  SHIPPED_ALLOWED,
} from './licence-gate.ts';
import { LOCKFILE_RULES } from './lockfile-gate.ts';
import { PIN_RULES } from './pin-gate.ts';
import { fixtureFile, loadFixtureWorkspace, readJsonList } from './shared.ts';
import type { Licence } from './shared.ts';

const fixtures = join(import.meta.dirname, 'fixtures');
const cleanDir = join(fixtures, 'clean');
const violationsDir = join(fixtures, 'violations');

function rulesFor(overlay: string | undefined): string[] {
  const ws = loadFixtureWorkspace(cleanDir, overlay);
  const violations = runAllGates(ws, {
    licences: readJsonList<Licence>(
      fixtureFile(cleanDir, overlay, 'licences.json'),
    ),
    shipped: readJsonList<Licence>(
      fixtureFile(cleanDir, overlay, 'shipped.json'),
    ),
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
