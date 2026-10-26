// M0-64 (follow-up): the decision whether this machine can build and run the Linux image, with no
// Docker daemon needed. The `toolchain (windows-2025)` job of `ci` runs `nx run-many -t build test`
// on a runner whose daemon runs Windows containers; the base images have no Windows manifest, so
// `docker build` failed on the pull. The probe now asks `docker info --format '{{.OSType}}'` and
// every docker step that needs the image skips loudly (exit 0) unless DOCKER_REQUIRE=1.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildPlan,
  daemonAnswers,
  daemonProblem,
  required,
  skipped,
} from './daemon.mjs';

const answer =
  (status, stdout = '') =>
  () => ({ status, stdout });

describe('daemonProblem (the injected `docker info --format {{.OSType}}`)', () => {
  it('a daemon that runs linux containers has no problem', () => {
    assert.equal(daemonProblem(answer(0, 'linux')), undefined);
    assert.equal(daemonAnswers(answer(0, 'linux')), true);
  });

  it('a daemon that runs windows containers is a problem that names windows', () => {
    const problem = daemonProblem(answer(0, 'windows'));
    assert.match(problem, /windows containers/);
    assert.match(problem, /linux/);
    assert.equal(daemonAnswers(answer(0, 'windows')), false);
  });

  it('no daemon (docker exits non-zero, or cannot be started) is a problem', () => {
    assert.equal(daemonProblem(answer(1)), 'no Docker daemon answers');
    assert.equal(daemonProblem(answer(undefined)), 'no Docker daemon answers');
    assert.equal(daemonAnswers(answer(1)), false);
  });

  it('a non-zero status is a problem even when stdout says linux', () => {
    assert.equal(daemonProblem(answer(1, 'linux')), 'no Docker daemon answers');
  });

  it('an answer that is not exactly linux is a problem, including an empty one', () => {
    assert.match(daemonProblem(answer(0, '')), /unknown containers/);
    assert.match(daemonProblem(answer(0, 'darwin')), /darwin containers/);
    assert.notEqual(daemonProblem(answer(0, 'linuxish')), undefined);
  });

  it('reads the answer case-insensitively', () => {
    assert.equal(daemonProblem(answer(0, 'Linux')), undefined);
  });
});

describe('buildPlan (what docker:build does)', () => {
  it('builds when the daemon can run linux containers, with or without DOCKER_REQUIRE', () => {
    assert.deepEqual(buildPlan(undefined, {}), {
      action: 'build',
      exitCode: 0,
    });
    assert.deepEqual(buildPlan(undefined, { DOCKER_REQUIRE: '1' }), {
      action: 'build',
      exitCode: 0,
    });
  });

  it('skips loudly with exit 0 when the daemon runs windows containers', () => {
    const problem = daemonProblem(answer(0, 'windows'));
    const plan = buildPlan(problem, {});
    assert.equal(plan.action, 'skip');
    assert.equal(plan.exitCode, 0);
    assert.match(plan.message, /SKIPPED/);
    assert.match(plan.message, /Nothing was proved/);
    assert.match(plan.message, /windows containers/);
  });

  it('skips loudly with exit 0 when no daemon answers', () => {
    const plan = buildPlan(daemonProblem(answer(1)), {});
    assert.equal(plan.action, 'skip');
    assert.equal(plan.exitCode, 0);
    assert.match(plan.message, /no Docker daemon answers/);
    assert.match(plan.message, /Nothing was proved/);
  });

  it('DOCKER_REQUIRE=1 turns both skips into failures with the same message', () => {
    for (const info of [answer(0, 'windows'), answer(1)]) {
      const problem = daemonProblem(info);
      const plan = buildPlan(problem, { DOCKER_REQUIRE: '1' });
      assert.equal(plan.action, 'fail');
      assert.equal(plan.exitCode, 1);
      assert.equal(plan.message, skipped('build', problem));
    }
  });

  it('only the exact value 1 requires', () => {
    assert.equal(required({ DOCKER_REQUIRE: '1' }), true);
    assert.equal(required({ DOCKER_REQUIRE: '0' }), false);
    assert.equal(required({ DOCKER_REQUIRE: 'true' }), false);
    assert.equal(required({}), false);
  });
});

describe('docker-tool.mjs build with no docker executable on PATH', () => {
  const tool = fileURLToPath(new URL('./docker-tool.mjs', import.meta.url));
  const run = (env) => {
    const empty = mkdtempSync(join(tmpdir(), 'no-docker-'));
    try {
      return spawnSync(process.execPath, [tool, 'build'], {
        encoding: 'utf8',
        env: { ...env, PATH: empty, Path: empty },
        timeout: 60_000,
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  };

  it('skips loudly and exits 0', () => {
    const result = run({});
    assert.equal(result.status, 0);
    assert.match(
      result.stderr,
      /docker build SKIPPED: no Docker daemon answers/,
    );
    assert.match(result.stderr, /Nothing was proved/);
  });

  it('exits 1 with DOCKER_REQUIRE=1', () => {
    const result = run({ DOCKER_REQUIRE: '1' });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /docker build SKIPPED: no Docker daemon answers/,
    );
  });
});
