// node --test tools/agent-hooks/guard-paths.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluate } from './guard-paths.mjs';
import { hooksDir, root, runHook, tempTree } from './test-utils.mjs';

const edit = (file_path, extra = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path, old_string: 'a', new_string: 'b', ...extra },
});

test('AC: an Edit targeting testing/lab-evidence/** exits 2 with "human-only path"', () => {
  const result = runHook(
    'guard-paths.mjs',
    edit('testing/lab-evidence/4.3.6/CF-SETTLE-001.json'),
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /human-only path/);
  assert.match(
    result.stderr,
    /testing\/lab-evidence\/4\.3\.6\/CF-SETTLE-001\.json/,
  );
});

test('the checked-in fixture payload is blocked', () => {
  const fixture = readFileSync(
    join(hooksDir, 'fixtures', 'guard-edit-lab-evidence.json'),
    'utf8',
  );
  const result = runHook('guard-paths.mjs', fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /human-only path/);
});

test('absolute paths and case variants are blocked too', () => {
  const absolute = join(root, 'testing', 'lab-evidence', 'x.json');
  assert.equal(runHook('guard-paths.mjs', edit(absolute)).status, 2);
  assert.equal(
    runHook('guard-paths.mjs', edit('Testing/Lab-Evidence/x.json')).status,
    2,
  );
  assert.equal(
    runHook('guard-paths.mjs', edit('testing/./lab-evidence/../lab-evidence/x'))
      .status,
    2,
  );
});

test('Write and MultiEdit to a protected path are blocked', () => {
  const write = {
    tool_name: 'Write',
    tool_input: { file_path: 'CODEOWNERS', content: '* @x\n' },
  };
  assert.equal(runHook('guard-paths.mjs', write).status, 2);
  const multi = {
    tool_name: 'MultiEdit',
    tool_input: { file_path: 'testing/lab-evidence/a.json', edits: [] },
  };
  assert.equal(runHook('guard-paths.mjs', multi).status, 2);
});

const blocked = [
  'testing/lab-evidence/4.3.6/CF-1.json',
  'testing/lab-evidence',
  '.github/workflows/release.yml',
  '.github/workflows/release-please.yml',
  '.github/workflows/release-desktop.yaml',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  'tools/supply-chain/deps-allowlist.json',
  'docs/adr/ADR-027-log.md',
  '.claude/settings.json',
  'tools/agent-hooks/guard-paths.mjs',
  'tools/agent-hooks/guard-bash.mjs',
  'tools/agent-hooks/post-edit.mjs',
  'tools/agent-hooks/on-stop.mjs',
  'tools/agent-hooks/lib.mjs',
  'tools/agent-hooks/protected-paths.mjs',
];
for (const path of blocked) {
  test(`protected: ${path}`, () => {
    const result = evaluate(edit(path), root);
    assert.equal(result.blocked, true);
    assert.match(result.message, /human-only path/);
  });
}

const allowed = [
  'libs/shared/contracts/src/index.ts',
  'docs/specs/M0-07.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/skills/wp-spec/SKILL.md',
  '.claude/rules/engine.md',
  'tools/agent-hooks/guard-paths.test.mjs',
  'tools/agent-hooks/README.md',
  '.github/workflows/ci.yml',
  'eslint.config.mjs',
  'docs/adr/ADR-027-supply-chain-gates-with-a-reviewed-release-age-exclusion-lis.md',
  'testing/oracle-amqp10/index.ts',
  'testing/lab-evidence-notes.md',
];
for (const path of allowed) {
  test(`allowed: ${path}`, () => {
    assert.deepEqual(evaluate(edit(path), root), { blocked: false });
  });
}

test('paths outside the checkout: another checkout is policed, user settings are not', () => {
  const other = tempTree({});
  try {
    const labEvidence = join(other.dir, 'testing', 'lab-evidence', 'x.json');
    assert.equal(evaluate(edit(labEvidence), root).blocked, true);
    const settings = join(other.dir, '.claude', 'settings.json');
    assert.equal(evaluate(edit(settings), root).blocked, false);
    assert.equal(
      evaluate(edit(join(other.dir, 'src', 'a.ts')), root).blocked,
      false,
    );
  } finally {
    other.cleanup();
  }
});

test('payloads without a file path are allowed (Bash, empty)', () => {
  assert.equal(
    runHook('guard-paths.mjs', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    }).status,
    0,
  );
  assert.equal(runHook('guard-paths.mjs', '').status, 0);
});

test('a payload that cannot be parsed fails closed', () => {
  const result = runHook('guard-paths.mjs', '{not json');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not valid JSON/);
});

test('relative paths resolve against the payload cwd', () => {
  const payload = {
    ...edit('lab-evidence/x.json'),
    cwd: join(root, 'testing'),
  };
  assert.equal(evaluate(payload, root).blocked, true);
});

// ---------------------------------------------------------------------------------------------
// pnpm-workspace.yaml: only the supply-chain keys are human-only
// ---------------------------------------------------------------------------------------------

const workspaceYaml = `# Supply-chain policy
minimumReleaseAge: 4320
minimumReleaseAgeStrict: true
minimumReleaseAgeExclude:
  - '@angular/core@22.2.3'
  - vitest@5.0.5

trustPolicy: no-downgrade
trustPolicyExclude:
  - semver@5.7.2
blockExoticSubdeps: true
strictDepBuilds: true

catalog:
  eslint: 10.12.0
  zod: 4.6.7

allowBuilds:
  nx: true
  esbuild: false
`;

function withWorkspace(run) {
  const tree = tempTree({ 'pnpm-workspace.yaml': workspaceYaml });
  try {
    run(tree.dir);
  } finally {
    tree.cleanup();
  }
}

test('pnpm-workspace.yaml: editing the catalog is allowed', () => {
  withWorkspace((dir) => {
    const payload = edit('pnpm-workspace.yaml', {
      old_string: '  zod: 4.6.7',
      new_string: '  zod: 4.6.8',
    });
    assert.equal(evaluate(payload, dir).blocked, false);
  });
});

test('pnpm-workspace.yaml: changing a supply-chain key is human-only', () => {
  withWorkspace((dir) => {
    for (const [from, to] of [
      ['minimumReleaseAge: 4320', 'minimumReleaseAge: 0'],
      ['minimumReleaseAgeStrict: true', 'minimumReleaseAgeStrict: false'],
      ['  - vitest@5.0.5', '  - vitest@5.0.5\n  - left-pad@1.3.0'],
      ['trustPolicy: no-downgrade', 'trustPolicy: off'],
      ['  esbuild: false', '  esbuild: true'],
    ]) {
      const result = evaluate(
        edit('pnpm-workspace.yaml', { old_string: from, new_string: to }),
        dir,
      );
      assert.equal(result.blocked, true, from);
      assert.match(
        result.message,
        /human-only path: pnpm-workspace\.yaml \(supply-chain keys: /,
      );
    }
  });
});

test('pnpm-workspace.yaml: adding an overrides block is human-only', () => {
  withWorkspace((dir) => {
    const payload = edit('pnpm-workspace.yaml', {
      old_string: 'catalog:\n',
      new_string: 'overrides:\n  undici: 7.29.1\n\ncatalog:\n',
    });
    assert.equal(evaluate(payload, dir).blocked, true);
  });
});

test('pnpm-workspace.yaml: comment-only changes are allowed', () => {
  withWorkspace((dir) => {
    const payload = edit('pnpm-workspace.yaml', {
      old_string: '# Supply-chain policy',
      new_string: '# Supply-chain policy (ADR-027)',
    });
    assert.equal(evaluate(payload, dir).blocked, false);
  });
});

test('pnpm-workspace.yaml: Write is compared with the file on disk', () => {
  withWorkspace((dir) => {
    const same = {
      tool_name: 'Write',
      tool_input: { file_path: 'pnpm-workspace.yaml', content: workspaceYaml },
    };
    assert.equal(evaluate(same, dir).blocked, false);
    const catalogOnly = workspaceYaml.replace('zod: 4.6.7', 'zod: 4.6.9');
    const ok = {
      tool_name: 'Write',
      tool_input: { file_path: 'pnpm-workspace.yaml', content: catalogOnly },
    };
    assert.equal(evaluate(ok, dir).blocked, false);
    const weakened = workspaceYaml.replace(
      'strictDepBuilds: true',
      'strictDepBuilds: false',
    );
    const bad = {
      tool_name: 'Write',
      tool_input: { file_path: 'pnpm-workspace.yaml', content: weakened },
    };
    assert.equal(evaluate(bad, dir).blocked, true);
  });
});

test('pnpm-workspace.yaml: MultiEdit is blocked when any edit touches a policy key', () => {
  withWorkspace((dir) => {
    const payload = {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: 'pnpm-workspace.yaml',
        edits: [
          { old_string: '  zod: 4.6.7', new_string: '  zod: 4.6.8' },
          {
            old_string: 'blockExoticSubdeps: true',
            new_string: 'blockExoticSubdeps: false',
          },
        ],
      },
    };
    assert.equal(evaluate(payload, dir).blocked, true);
  });
});

test('pnpm-workspace.yaml: an edit that cannot be replayed is judged by its text', () => {
  withWorkspace((dir) => {
    const mentionsKey = edit('pnpm-workspace.yaml', {
      old_string: 'not in the file',
      new_string: 'minimumReleaseAge: 0',
    });
    assert.equal(evaluate(mentionsKey, dir).blocked, true);
    const harmless = edit('pnpm-workspace.yaml', {
      old_string: 'not in the file',
      new_string: 'x: 1',
    });
    assert.equal(evaluate(harmless, dir).blocked, false);
  });
});
