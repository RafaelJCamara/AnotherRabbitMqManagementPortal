// Self-test for the actions pin gate (`nx run supply-chain:actions-pinned-selftest`).
// Planted workflows are inline strings so no scanner or the real gate ever sees them as workflows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIONS_RULES, checkActionsPinned } from './actions-pinned.ts';

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

function workflow(usesLines: string, withBlock = ''): string {
  return [
    'name: planted',
    'on: push',
    'jobs:',
    '  job:',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    usesLines,
    withBlock,
  ].join('\n');
}

function rules(text: string): string[] {
  return [
    ...new Set(
      checkActionsPinned([{ path: 'planted.yml', text }]).map((v) => v.rule),
    ),
  ].sort();
}

const cleanCheckout = workflow(
  `      - uses: actions/checkout@${SHA} # v7.0.1`,
  '        with:\n          persist-credentials: false',
);

test('a SHA-pinned checkout with a version comment and persist-credentials false passes', () => {
  assert.deepEqual(rules(cleanCheckout), []);
});

test('local composite actions need no pin', () => {
  assert.deepEqual(
    rules(workflow('      - uses: ./.github/actions/setup')),
    [],
  );
  assert.deepEqual(
    rules(workflow('      - uses: $/.github/actions/setup')),
    [],
  );
});

test('a tag ref fails actions.not-sha-pinned', () => {
  assert.deepEqual(
    rules(workflow('      - uses: actions/setup-node@v4 # v4')),
    ['actions.not-sha-pinned'],
  );
});

test('a branch ref fails actions.not-sha-pinned', () => {
  assert.deepEqual(rules(workflow('      - uses: owner/repo@main')), [
    'actions.not-sha-pinned',
  ]);
});

test('a 39-character SHA fails actions.not-sha-pinned', () => {
  assert.deepEqual(
    rules(workflow(`      - uses: owner/repo@${SHA.slice(1)} # v1.0.0`)),
    ['actions.not-sha-pinned'],
  );
});

test('an unpinned reusable workflow fails actions.not-sha-pinned', () => {
  assert.deepEqual(
    rules(workflow('      - uses: owner/repo/.github/workflows/x.yml@v1 # v1')),
    ['actions.not-sha-pinned'],
  );
});

test('a SHA without a version comment fails actions.missing-version-comment', () => {
  assert.deepEqual(rules(workflow(`      - uses: owner/repo@${SHA}`)), [
    'actions.missing-version-comment',
  ]);
});

test('a docker action pinned by tag fails actions.docker-not-digest', () => {
  assert.deepEqual(
    rules(workflow('      - uses: docker://ghcr.io/owner/image:1.0')),
    ['actions.docker-not-digest'],
  );
});

test('a docker action pinned by digest passes', () => {
  assert.deepEqual(
    rules(
      workflow(
        `      - uses: docker://ghcr.io/owner/image@sha256:${'a'.repeat(64)}`,
      ),
    ),
    [],
  );
});

test('a checkout without persist-credentials false fails actions.persist-credentials', () => {
  assert.deepEqual(
    rules(workflow(`      - uses: actions/checkout@${SHA} # v7.0.1`)),
    ['actions.persist-credentials'],
  );
});

test('a checkout with persist-credentials true fails actions.persist-credentials', () => {
  assert.deepEqual(
    rules(
      workflow(
        `      - uses: actions/checkout@${SHA} # v7.0.1`,
        '        with:\n          persist-credentials: true',
      ),
    ),
    ['actions.persist-credentials'],
  );
});

test('composite action steps are checked too', () => {
  const composite = [
    'name: planted',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - uses: owner/repo@v1 # v1',
  ].join('\n');
  assert.deepEqual(rules(composite), ['actions.not-sha-pinned']);
});

test('every rule id is exercised by a planted violation', () => {
  const seen = new Set<string>();
  for (const text of [
    workflow('      - uses: owner/repo@main'),
    workflow(`      - uses: owner/repo@${SHA}`),
    workflow('      - uses: docker://ghcr.io/owner/image:1.0'),
    workflow(`      - uses: actions/checkout@${SHA} # v7.0.1`),
  ]) {
    for (const rule of rules(text)) seen.add(rule);
  }
  assert.deepEqual([...seen].sort(), [...ACTIONS_RULES].sort());
});
