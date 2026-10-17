// node --test tools/agent-hooks/toolchain.test.mjs
//
// Static checks on the agent toolchain files (M0-07): CLAUDE.md, AGENTS.md, settings, rules,
// skills, the spec template and CODEOWNERS. They keep the files honest as they change.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { PROTECTED_PATHS } from './protected-paths.mjs';
import { root } from './test-utils.mjs';

const read = (path) => readFileSync(join(root, path), 'utf8');

/** Splits `---` frontmatter from a Markdown file. */
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match, 'expected YAML frontmatter');
  return match[1] ?? '';
}

test('AC: CLAUDE.md is under 200 lines and imports @AGENTS.md', () => {
  const lines = read('CLAUDE.md').split(/\r?\n/);
  assert.ok(lines.length < 200, `CLAUDE.md has ${lines.length} lines`);
  assert.equal(lines[0], '@AGENTS.md');
});

test('AGENTS.md lists every invariant and the protected paths', () => {
  const text = read('AGENTS.md');
  for (let n = 1; n <= 14; n += 1)
    assert.ok(text.includes(`| I-${n} |`), `I-${n} is missing`);
  for (const phrase of [
    'testing/lab-evidence/**',
    'deps-allowlist.json',
    'ADR-027-log.md',
    'CODEOWNERS',
  ]) {
    assert.ok(text.includes(phrase), `${phrase} is not mentioned`);
  }
  assert.match(text, /Signed-off-by/);
  assert.match(text, /Co-Authored-By/);
});

test('settings.json wires the four hooks as documented and every script exists', () => {
  const settings = JSON.parse(read('.claude/settings.json'));
  const flat = (event) =>
    (settings.hooks[event] ?? []).flatMap((entry) =>
      entry.hooks.map((hook) => ({ matcher: entry.matcher, ...hook })),
    );

  const pre = flat('PreToolUse');
  const paths = pre.find((hook) => hook.command.includes('guard-paths.mjs'));
  const bash = pre.find((hook) => hook.command.includes('guard-bash.mjs'));
  assert.equal(paths?.matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  assert.equal(bash?.matcher, 'Bash');

  const post = flat('PostToolUse');
  assert.equal(post.length, 1);
  assert.equal(post[0].matcher, 'Edit|Write|MultiEdit');
  assert.ok(post[0].command.includes('post-edit.mjs'));

  const stop = flat('Stop');
  assert.equal(stop.length, 1);
  assert.ok(stop[0].command.includes('on-stop.mjs'));
  assert.equal(stop[0].timeout, 900);

  for (const hook of [...pre, ...post, ...stop]) {
    assert.equal(hook.type, 'command');
    const script = /tools\/agent-hooks\/[\w-]+\.mjs/.exec(hook.command)?.[0];
    assert.ok(
      script && existsSync(join(root, script)),
      `${hook.command} points at a missing script`,
    );
    assert.match(
      hook.command,
      /^node /,
      'hooks run through node, not a shell script',
    );
  }
});

test('the rules files carry path-scoped frontmatter', () => {
  for (const name of [
    'engine',
    'ui',
    'desktop',
    'semantics',
    'security',
    'release',
  ]) {
    const meta = frontmatter(read(`.claude/rules/${name}.md`));
    assert.match(meta, /^paths:\s*$/m, `${name}.md needs paths:`);
    assert.match(
      meta,
      /^\s+- '.+'$/m,
      `${name}.md needs at least one path glob`,
    );
  }
});

test('the skills exist with a matching name and a description', () => {
  const skills = [
    'wp-spec',
    'review-wp',
    'new-action',
    'new-adapter',
    'new-ui-feature',
    'new-eslint-rule',
    'new-lint-rule',
    'new-decoder',
    'new-semantics-cell',
    'security-lane',
    'release',
  ];
  const agents = read('AGENTS.md');
  for (const name of skills) {
    const meta = frontmatter(read(`.claude/skills/${name}/SKILL.md`));
    assert.match(meta, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(
      meta,
      /^description: .{40,}/m,
      `${name} needs a useful description`,
    );
    assert.ok(
      agents.includes(`\`/${name}\``),
      `AGENTS.md does not index /${name}`,
    );
  }
});

test('skills for generators say which work package ships them and never claim they exist', () => {
  const shipping = {
    'new-action': 'M0-35',
    'new-adapter': 'M0-08',
    'new-ui-feature': 'M0-08',
    'new-eslint-rule': 'M0-08',
    'new-lint-rule': 'M0-08',
    'new-decoder': 'M0-08',
    'new-semantics-cell': 'M0-08',
  };
  for (const [name, wp] of Object.entries(shipping)) {
    const text = read(`.claude/skills/${name}/SKILL.md`);
    assert.match(text, /## Availability/);
    assert.ok(text.includes(`**${wp}**`), `${name} should name ${wp}`);
    assert.match(text, /--help/);
  }
});

test('the spec template has the sections of execution plan 2.6', () => {
  const text = read('docs/specs/_TEMPLATE.md');
  for (const heading of [
    '# <WP-id> <title>',
    '## Goal',
    '## Files & interfaces',
    '## Out of scope',
    '## Acceptance criteria',
    '## Verification',
    '## Risks / questions',
    '## DoD checklist',
  ]) {
    assert.ok(text.includes(heading), `${heading} is missing`);
  }
});

// ---------------------------------------------------------------------------------------------
// CODEOWNERS
// ---------------------------------------------------------------------------------------------

const codeowners = read('CODEOWNERS')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))
  .map((line) => {
    const [pattern, ...owners] = line.split(/\s+/);
    return { pattern: pattern ?? '', owners };
  });

/** A small matcher for the patterns used in this CODEOWNERS file. */
function matches(pattern, path) {
  const anchored = pattern.startsWith('/');
  let source = pattern.replace(/^\//, '');
  const directory = source.endsWith('/');
  if (directory) source = source.slice(0, -1);
  const body = source
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '@@GLOB@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@GLOB@@/g, '.*');
  const prefix = anchored ? '^' : '(^|/)';
  return new RegExp(`${prefix}${body}${directory ? '/' : '(/|$)'}`).test(path);
}

test('CODEOWNERS: every entry has a named owner and lab evidence is covered', () => {
  assert.ok(codeowners.length > 10);
  for (const { pattern, owners } of codeowners) {
    assert.ok(owners.length > 0, `${pattern} has no owner`);
    for (const owner of owners)
      assert.match(owner, /^@[A-Za-z0-9-]+$/, `${pattern}: ${owner}`);
  }
  const lab = codeowners.find(
    (entry) => entry.pattern === '/testing/lab-evidence/**',
  );
  assert.deepEqual(lab?.owners, ['@RafaelJCamara']);
});

test('CODEOWNERS covers every protected path and the trust-critical locations', () => {
  const samples = [
    'testing/lab-evidence/4.3.6/CF-1.json',
    '.github/workflows/release.yml',
    'CODEOWNERS',
    'pnpm-workspace.yaml',
    'tools/supply-chain/deps-allowlist.json',
    'docs/adr/ADR-027-log.md',
    '.claude/settings.json',
    'tools/agent-hooks/guard-paths.mjs',
    'libs/engine/secrets/src/index.ts',
    'libs/engine/svc-identity/src/index.ts',
    'libs/engine/svc-access/src/index.ts',
    'libs/engine/svc-audit/src/index.ts',
    'libs/engine/net-dialer/src/index.ts',
    'libs/engine/net-truststore/src/index.ts',
    'libs/engine/transport/src/index.ts',
    'libs/engine/svc-mcp/src/index.ts',
    'apps/desktop/src/main/main.ts',
    'apps/desktop/src/preload/preload.ts',
    'libs/shared/semantics/src/data/settle-matrix.data.ts',
    'libs/engine/svc-peek/src/module.ts',
    'libs/engine/kernel/src/actions/index.ts',
    'apps/conformance/src/main.ts',
    'packaging/helm/product/Chart.yaml',
  ];
  for (const path of samples) {
    assert.ok(
      codeowners.some(({ pattern }) => matches(pattern, path)),
      `${path} is not covered by CODEOWNERS`,
    );
  }
  // Every protected-path entry is represented by a sample above.
  for (const entry of PROTECTED_PATHS) {
    assert.ok(
      samples.some((sample) => entry.match(sample.toLowerCase())),
      `no sample exercises the protected entry ${entry.id}`,
    );
  }
  // Ordinary code is not owned (no catch-all entry).
  assert.ok(
    !codeowners.some(({ pattern }) =>
      matches(pattern, 'libs/shared/contracts/src/index.ts'),
    ),
  );
});
