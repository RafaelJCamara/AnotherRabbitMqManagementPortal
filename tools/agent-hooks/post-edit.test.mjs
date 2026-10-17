// node --test tools/agent-hooks/post-edit.test.mjs
//
// These tests run the real prettier and eslint (type-aware, with the repository config) on files
// written to a throwaway folder inside tools/agent-hooks. The folder carries its own tsconfig.json
// so typescript-eslint's project service finds it. It is removed afterwards. It must not be
// git-ignored, because prettier skips git-ignored files.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { hooksDir, root, runHook, tempTree } from './test-utils.mjs';

const tsconfig = JSON.stringify({
  extends: '../../../tsconfig.base.json',
  compilerOptions: { noEmit: true },
  include: ['*.ts'],
});

let tree;
before(() => {
  tree = tempTree({ 'tsconfig.json': tsconfig }, hooksDir);
});
after(() => tree.cleanup());

const editPayload = (file_path) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path, old_string: 'a', new_string: 'b' },
  tool_response: { success: true },
});

test('AC: a mis-formatted .ts file with a lint error is formatted, and exit 2 reports the remaining error', () => {
  const file = join(tree.dir, 'mixed.ts');
  writeFileSync(
    file,
    [
      'export function  add(a:number,b:number){ let total = a+b;  return total }',
      "export const loose: any = JSON.parse('{}')",
      '',
    ].join('\n'),
  );

  const result = runHook('post-edit.mjs', editPayload(file));

  assert.equal(result.status, 2, result.stderr);
  // The remaining error is reported ...
  assert.match(result.stderr, /@typescript-eslint\/no-explicit-any/);
  assert.match(result.stderr, /still has problems after formatting/);
  // ... the fixable one (prefer-const) is not ...
  assert.doesNotMatch(result.stderr, /prefer-const/);
  // ... the file on disk is formatted and auto-fixed ...
  const after = readFileSync(file, 'utf8');
  assert.match(after, /export function add\(a: number, b: number\) \{/);
  assert.match(after, /const total = a \+ b;/);
  assert.match(after, /JSON\.parse\('\{\}'\);/);
  // ... and the agent is told the file changed under it.
  assert.match(result.stderr, /reformatted or auto-fixed/);
  // The expected noise from the Nx rule is not shown.
  assert.doesNotMatch(result.stderr, /ProjectGraph/);
});

test('a mis-formatted but lint-clean .ts file is formatted and the hook exits 0', () => {
  const file = join(tree.dir, 'clean.ts');
  writeFileSync(file, 'export const answer   =   42\n');
  const result = runHook('post-edit.mjs', editPayload(file));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(file, 'utf8'), 'export const answer = 42;\n');
});

test('relative paths are resolved against the repository root', () => {
  const file = join(tree.dir, 'relative.ts');
  writeFileSync(file, 'export const n   = 1\n');
  const rel = file.slice(root.length + 1).replaceAll('\\', '/');
  const result = runHook('post-edit.mjs', editPayload(rel));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(file, 'utf8'), 'export const n = 1;\n');
});

test('JSON files are formatted by prettier', () => {
  const file = join(tree.dir, 'data.json');
  writeFileSync(file, '{"a":1,\n"b":[1,2]}');
  const result = runHook('post-edit.mjs', editPayload(file));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(file, 'utf8'), '{ "a": 1, "b": [1, 2] }\n');
});

test('a syntax error is reported instead of being swallowed', () => {
  const file = join(tree.dir, 'broken.ts');
  writeFileSync(file, 'export const = ;\n');
  const result = runHook('post-edit.mjs', editPayload(file));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /prettier could not format the file/);
});

test('the checked-in fixture (verification command) reports the lint error and changes nothing', () => {
  const fixtureDir = join(hooksDir, 'fixtures');
  const sample = join(fixtureDir, 'sample.ts');
  const before = readFileSync(sample, 'utf8');
  const payload = readFileSync(join(fixtureDir, 'edit.json'), 'utf8');

  const result = runHook('post-edit.mjs', payload);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /fixtures\/sample\.ts/);
  assert.match(result.stderr, /@typescript-eslint\/no-explicit-any/);
  assert.equal(readFileSync(sample, 'utf8'), before);
});

test('nothing to do: missing file, outside the repo, unsupported type, no path, empty input', () => {
  assert.equal(
    runHook('post-edit.mjs', editPayload(join(tree.dir, 'missing.ts'))).status,
    0,
  );
  assert.equal(
    runHook(
      'post-edit.mjs',
      editPayload(join(tree.dir, '..', '..', '..', '..', 'x.ts')),
    ).status,
    0,
  );

  const notes = join(tree.dir, 'notes.md');
  writeFileSync(notes, '#   Title\n');
  assert.equal(runHook('post-edit.mjs', editPayload(notes)).status, 0);
  assert.equal(readFileSync(notes, 'utf8'), '#   Title\n');

  assert.equal(
    runHook('post-edit.mjs', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    }).status,
    0,
  );
  assert.equal(runHook('post-edit.mjs', '').status, 0);
});

test('a malformed payload never blocks (the edit already happened)', () => {
  const result = runHook('post-edit.mjs', '{oops');
  assert.equal(result.status, 0);
  assert.match(result.stderr, /not valid JSON/);
});
