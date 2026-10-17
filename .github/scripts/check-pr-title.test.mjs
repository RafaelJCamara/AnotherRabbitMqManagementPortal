// node --test .github/scripts/check-pr-title.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTitle } from './check-pr-title.mjs';

test('"feat(engine): add probe" passes', () => {
  assert.equal(checkTitle('feat(engine): add probe'), undefined);
});

test('"update stuff" fails', () => {
  assert.match(checkTitle('update stuff') ?? '', /not a Conventional Commit/);
});

for (const ok of [
  'fix: reject empty vhost names',
  'fix!: reject empty vhost names',
  'feat(ui-graph)!: draw exchanges',
  'chore(deps): bump nx',
  'ci: add dco check',
  'docs(adr): record ADR-035',
  'feat(engine,ui): share the probe',
]) {
  test(`passes: ${ok}`, () => assert.equal(checkTitle(ok), undefined));
}

for (const bad of [
  '',
  'Update stuff',
  'feat: ',
  'feat:no space',
  'feat(Engine): uppercase scope',
  'feature: unknown type',
  'FEAT: uppercase type',
  'feat(): empty scope',
  ' feat: leading space',
  'feat: first line\nsecond line',
  `feat: ${'x'.repeat(100)}`,
]) {
  test(`fails: ${JSON.stringify(bad)}`, () =>
    assert.notEqual(checkTitle(bad), undefined));
}

test('a missing title fails', () => {
  assert.notEqual(checkTitle(undefined), undefined);
});
