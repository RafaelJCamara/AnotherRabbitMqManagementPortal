// M0-64: the static checks of the container image. They read the Dockerfile, its ignore file, the
// compose file and the image workflow as text and assert what the image must be, so a change that
// loosens one of them fails here without a Docker daemon. Whether a built image really behaves
// that way is `image.live.test.mjs` (it needs a daemon).
//
//   node --test packaging/docker/dockerfile.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { declaredVariables, of, parseDockerfile } from './dockerfile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const dockerfileText = read('./Dockerfile');
const { stages, globalArgs } = parseDockerfile(dockerfileText);
const [build, runtime] = stages;
const compose = parse(read('./compose.yaml'));
const workflow = parse(read('../../.github/workflows/image.yml'));
const ignore = read('./Dockerfile.dockerignore')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

const DIGEST = /@sha256:[0-9a-f]{64}$/;
const SECRETISH =
  /(TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|API_?KEY|PRIVATE|KEK)/i;

const nvmrcMajor = readFileSync(`${root}.nvmrc`, 'utf8').trim().split('.')[0];

describe('M0-64 Dockerfile: two stages, pinned by digest', () => {
  it('AC-1 has a build stage and a runtime stage, and nothing else', () => {
    assert.equal(stages.length, 2);
    assert.equal(build.alias, 'build');
    assert.equal(runtime.alias, 'runtime');
    assert.deepEqual(globalArgs, [], 'no ARG before the first FROM');
  });

  it('AC-1 pins both base images by tag and digest, never by a floating tag', () => {
    for (const stage of stages) {
      assert.match(stage.image, DIGEST, `${stage.alias}: ${stage.image}`);
      assert.ok(!/:latest@/.test(stage.image), `${stage.alias} uses latest`);
      assert.match(stage.image, /:[^@:/]+@/, `${stage.alias} keeps a tag too`);
    }
  });

  it('AC-1 builds on node trixie-slim of the Node major in .nvmrc and runs on distroless nodejs24 nonroot', () => {
    const buildImage = /^node:(\d+)\.\d+\.\d+-trixie-slim@/.exec(build.image);
    assert.ok(buildImage, `unexpected build image ${build.image}`);
    assert.equal(buildImage[1], nvmrcMajor);
    assert.match(
      runtime.image,
      /^gcr\.io\/distroless\/nodejs24-debian13:nonroot@sha256:/,
    );
    assert.equal(
      `nodejs${nvmrcMajor}`,
      'nodejs24',
      'the runtime image and .nvmrc name the same Node major',
    );
  });

  it('AC-1 installs with the pnpm that package.json pins and the frozen lockfile, in the build stage only', () => {
    const run = of(build, 'RUN').map((i) => i.args);
    assert.ok(
      run.some((r) => /packageManager/.test(r) && /pnpm@/.test(r)),
      'pnpm is installed at the packageManager version',
    );
    assert.ok(run.some((r) => /pnpm install --frozen-lockfile/.test(r)));
    assert.ok(
      run.some((r) => /pnpm nx run-many -t build -p engine web/.test(r)),
    );
    const lines = of(build, 'RUN').flatMap(
      (i) => i.args.match(/pnpm@[^\s"]+/g) ?? [],
    );
    for (const pinned of lines) {
      assert.ok(!/@latest|@\^|@~/.test(pinned), pinned);
    }
  });
});

describe('M0-64 Dockerfile: the runtime stage is minimal and non-root', () => {
  it('AC-2 runs as a numeric non-root user', () => {
    const users = of(runtime, 'USER');
    assert.equal(users.length, 1);
    const [uid, gid] = users[0].args.split(':');
    assert.match(
      uid,
      /^[1-9]\d*$/,
      'a numeric uid above 0 (runAsNonRoot checks need a number)',
    );
    assert.match(gid ?? '', /^[1-9]\d*$/);
    assert.equal(uid, '65532', 'the uid of the distroless nonroot user');
  });

  it('AC-2 runs nothing at build time in the runtime stage (it has no shell) and adds nothing from outside', () => {
    assert.deepEqual(of(runtime, 'RUN'), []);
    assert.deepEqual(of(runtime, 'ADD'), []);
    for (const copy of of(runtime, 'COPY')) {
      assert.equal(copy.flags.from, 'build', copy.args);
    }
  });

  it('AC-2 copies only the named runtime tree, never the source or the whole context', () => {
    const sources = of(runtime, 'COPY').map((c) => c.args.split(/\s+/)[0]);
    assert.deepEqual(sources.sort(), [
      '/out/app',
      '/out/data',
      '/out/licenses',
    ]);
  });

  it('AC-2 gives /data to the runtime user and declares it a volume, so a named volume starts writable', () => {
    const data = of(runtime, 'COPY').find((c) => c.args.endsWith(' /data'));
    assert.equal(data?.flags.chown, '65532:65532');
    const app = of(runtime, 'COPY').find((c) => c.args.endsWith(' /app'));
    assert.equal(
      app?.flags.chown,
      undefined,
      'the application stays root-owned and read-only',
    );
    assert.deepEqual(
      of(runtime, 'VOLUME').map((v) => v.exec),
      [['/data']],
    );
    const volumeAt = runtime.instructions.findIndex((i) => i.name === 'VOLUME');
    const dataAt = runtime.instructions.findIndex((i) => i === data);
    assert.ok(
      dataAt < volumeAt,
      '/data is populated before it is declared a volume',
    );
  });

  it('AC-2 bakes in no secret: no secret-looking ENV, ARG or LABEL value, no copied key or env file', () => {
    for (const stage of stages) {
      for (const { key, value, kind } of declaredVariables(stage)) {
        if (!SECRETISH.test(key)) continue;
        assert.equal(value, '', `${kind} ${key} has a value in ${stage.alias}`);
        assert.equal(kind, 'ARG', `${key} must not be an ENV`);
      }
    }
    assert.ok(
      !/\.(pem|key|kek)\b|\.env\b/.test(dockerfileText.replace(/#.*$/gm, '')),
    );
    assert.ok(
      !/\bcurl\b|\bwget\b/.test(dockerfileText.replace(/#.*$/gm, '')),
      'no download in the image build',
    );
  });

  it('AC-2 leaves source maps and the esbuild metafile out of the runtime tree', () => {
    const cleanup = of(build, 'RUN').find((r) => r.args.includes('/out/app'));
    assert.ok(cleanup);
    assert.match(cleanup.args, /-name '\*\.map'/);
    assert.match(cleanup.args, /-name 'meta\.json'/);
  });
});

describe('M0-64 Dockerfile: the runtime contract of the engine', () => {
  it('AC-3 sets APP_RUNTIME=container and no other APP_ variable (an unknown one is a usage error)', () => {
    const variables = declaredVariables(runtime).filter(
      (v) => v.kind === 'ENV',
    );
    const app = variables.filter((v) => v.key.startsWith('APP_'));
    assert.deepEqual(app, [
      { key: 'APP_RUNTIME', value: 'container', kind: 'ENV' },
    ]);
  });

  it('AC-3 starts the bundle in exec form with --mode=local, so SIGTERM reaches the engine', () => {
    const [entry] = of(runtime, 'ENTRYPOINT');
    assert.deepEqual(entry.exec, [
      '/nodejs/bin/node',
      '/app/engine/main.mjs',
      '--mode=local',
    ]);
    assert.equal(of(runtime, 'CMD').length, 0);
    assert.equal(
      of(runtime, 'STOPSIGNAL').length,
      0,
      'the default SIGTERM is the one the engine drains on',
    );
  });

  it('AC-3 puts the bundle where the engine looks for the web build (next to it, in ../web/browser)', () => {
    const copy = of(build, 'RUN').find((r) => r.args.includes('/out/app'));
    assert.match(copy.args, /cp -r dist\/apps\/engine \/out\/app\/engine/);
    assert.match(
      copy.args,
      /cp -r dist\/apps\/web\/browser \/out\/app\/web\/browser/,
    );
    // modes/local.ts: join(bundleDir, '..', 'web', 'browser')
    assert.match(
      readFileSync(`${root}apps/engine/src/modes/local.ts`, 'utf8'),
      /join\(host\.bundleDir, '\.\.', 'web', 'browser'\)/,
    );
  });

  it('AC-3 has a HEALTHCHECK in exec form that runs the engine healthcheck client from the repository', () => {
    const [check] = of(runtime, 'HEALTHCHECK');
    assert.match(check.args, /^CMD \[/, 'CMD with the exec form');
    assert.deepEqual(JSON.parse(check.args.replace(/^CMD\s+/, '')), [
      '/nodejs/bin/node',
      '/app/engine/healthcheck.mjs',
    ]);
    const source = 'apps/engine/scripts/healthcheck.mjs';
    assert.ok(existsSync(`${root}${source}`));
    assert.ok(
      of(build, 'RUN').some((r) =>
        r.args.includes(`cp ${source} /out/app/engine/healthcheck.mjs`),
      ),
    );
    assert.ok(
      !existsSync(new URL('./healthcheck.mjs', import.meta.url)),
      'one healthcheck source, not a copy that can drift',
    );
  });

  it('AC-3 times the HEALTHCHECK so a slow start is not a failure and a dead engine is noticed', () => {
    const [check] = of(runtime, 'HEALTHCHECK');
    assert.equal(check.flags.timeout, '5s');
    assert.equal(check.flags.interval, '30s');
    assert.match(check.flags['start-period'], /^\d+s$/);
    assert.equal(check.flags.retries, '3');
  });

  it('AC-3 exposes the one documented port and no other', () => {
    assert.deepEqual(
      of(runtime, 'EXPOSE').map((e) => e.args),
      ['8765'],
    );
  });
});

describe('M0-64 build context', () => {
  it('AC-4 keeps node_modules, dist, git, env files and keys out of the build context', () => {
    for (const must of [
      '**/node_modules',
      '**/dist',
      '.git',
      '**/.env',
      '**/.env.*',
      '**/*.pem',
      '**/*.key',
      '**/*.kek',
    ]) {
      assert.ok(ignore.includes(must), `Dockerfile.dockerignore lacks ${must}`);
    }
    assert.ok(!ignore.some((line) => line.startsWith('!')), 'no re-inclusion');
  });

  it('AC-4 keeps what the engine and web builds need in the context', () => {
    for (const needed of [
      'apps',
      'libs',
      'tools',
      'packaging',
      'LICENSE',
      'NOTICE',
      'package.json',
      'pnpm-lock.yaml',
      'nx.json',
    ]) {
      assert.ok(!ignore.includes(needed), `${needed} must stay in the context`);
    }
    for (const file of [
      'LICENSE',
      'NOTICE',
      'pnpm-lock.yaml',
      'tsconfig.base.json',
    ]) {
      assert.ok(existsSync(`${root}${file}`), file);
    }
  });
});

describe('M0-64 compose file', () => {
  const app = compose.services.app;

  it('AC-5 publishes the port on 127.0.0.1 only, never on every interface or on the host network', () => {
    assert.equal(app.ports.length, 1);
    assert.match(
      String(app.ports[0]),
      /^127\.0\.0\.1:\$\{APP_HOST_PORT:-8765\}:8765$/,
    );
    assert.equal(app.network_mode, undefined);
    assert.ok(!JSON.stringify(compose).includes('0.0.0.0'));
  });

  it('AC-5 runs with a read-only root filesystem, a tmpfs for /tmp, no capability and no privilege gain', () => {
    assert.equal(app.read_only, true);
    assert.ok(app.tmpfs.some((t) => t.startsWith('/tmp')));
    assert.deepEqual(app.cap_drop, ['ALL']);
    assert.ok(app.security_opt.includes('no-new-privileges:true'));
    assert.equal(app.privileged, undefined);
    assert.equal(app.cap_add, undefined);
  });

  it('AC-5 passes the token and the key as secret files, never as values', () => {
    assert.equal(app.environment.APP_TOKEN_FILE, '/run/secrets/app_token');
    assert.equal(app.environment.APP_KEK_PATH, '/run/secrets/app_kek');
    assert.equal(app.environment.APP_TOKEN, undefined);
    assert.deepEqual(app.secrets, ['app_token', 'app_kek']);
    for (const name of Object.keys(app.environment)) {
      assert.ok(
        !SECRETISH.test(name) ||
          name === 'APP_TOKEN_FILE' ||
          name === 'APP_KEK_PATH',
        `${name} looks like a secret value`,
      );
    }
  });

  it('AC-5 keeps the data in a named volume at /data and only sets APP_ names the engine knows', () => {
    assert.deepEqual(app.volumes, ['app-data:/data']);
    assert.ok('app-data' in compose.volumes);
    const known = [
      'APP_RUNTIME',
      'APP_HOST',
      'APP_PORT',
      'APP_DATA_DIR',
      'APP_KEK_PATH',
      'APP_UI_DIR',
      'APP_PUBLIC_ORIGIN',
      'APP_TOKEN',
      'APP_TOKEN_FILE',
      'APP_LOG_LEVEL',
    ];
    for (const name of Object.keys(app.environment))
      assert.ok(known.includes(name), name);
    assert.match(
      app.environment.APP_PUBLIC_ORIGIN,
      /^http:\/\/127\.0\.0\.1:/,
      'a loopback origin only (A-12)',
    );
  });

  it('AC-5 gives the engine room for its 2 s drain before SIGKILL', () => {
    assert.match(String(app.stop_grace_period), /^([3-9]|10)s$/);
  });

  it('AC-5 builds from this Dockerfile with the repository as the context', () => {
    assert.equal(app.build.context, '../..');
    assert.equal(app.build.dockerfile, 'packaging/docker/Dockerfile');
  });
});

describe('M0-64 image workflow', () => {
  const jobs = workflow.jobs;

  it('AC-6 asks for no permission by default and gives id-token: write to the signing job only', () => {
    assert.deepEqual(workflow.permissions, {});
    const withToken = Object.entries(jobs).filter(
      ([, job]) => job.permissions?.['id-token'] === 'write',
    );
    assert.deepEqual(
      withToken.map(([name]) => name),
      ['merge'],
    );
    assert.equal(
      jobs.verify.permissions['packages'],
      undefined,
      'the job that runs the image never holds a registry token',
    );
    assert.deepEqual(jobs.verify.permissions, { contents: 'read' });
  });

  it('AC-6 builds each architecture natively and scans each build', () => {
    const runners = jobs.verify.strategy.matrix.include;
    assert.deepEqual(
      runners.map((r) => [r.arch, r.runner]),
      [
        ['amd64', 'ubuntu-24.04'],
        ['arm64', 'ubuntu-24.04-arm'],
      ],
    );
    assert.ok(!JSON.stringify(workflow).includes('setup-qemu'), 'no emulation');
    const trivy = jobs.verify.steps.find((s) =>
      String(s.uses).startsWith('aquasecurity/trivy-action@'),
    );
    assert.equal(trivy.with.severity, 'CRITICAL');
    assert.equal(trivy.with['exit-code'], '1');
    assert.ok(
      !('ignore-unfixed' in trivy.with),
      'an unfixed CRITICAL still fails (OQ-1488)',
    );
  });

  it('AC-6 runs the docker test suite against the built image and fails when no daemon answers', () => {
    const step = jobs.verify.steps.find((s) =>
      /image\.live\.test\.mjs/.test(String(s.run)),
    );
    assert.equal(step.env.DOCKER_REQUIRE, '1');
    assert.ok(step.env.DOCKER_IMAGE);
    assert.match(step.run, /dockerfile\.test\.mjs/);
  });

  it('AC-6 pushes by digest with SBOM and provenance, signs keyless, and verifies the signature and both platforms', () => {
    const push = jobs.push.steps.find((s) =>
      String(s.uses).startsWith('docker/build-push-action@'),
    );
    assert.match(push.with.outputs, /push-by-digest=true/);
    assert.equal(push.with.provenance, 'mode=max');
    assert.equal(push.with.sbom, true);
    const text = JSON.stringify(jobs.merge.steps);
    assert.match(text, /cosign sign --yes/);
    assert.match(text, /cosign verify/);
    assert.match(text, /token\.actions\.githubusercontent\.com/);
    assert.match(text, /image\\\\\.yml@/, 'the identity names this workflow');
    assert.match(text, /amd64,arm64/);
    assert.ok(!/cosign sign[^"]*--key/.test(text), 'keyless, no key');
  });

  it('AC-6 publishes only with the IMAGE_NAME variable set and on a tag or the default branch, never from a pull request', () => {
    for (const job of [jobs.push]) {
      assert.match(job.if, /vars\.IMAGE_NAME != ''/);
      assert.match(job.if, /ref_type == 'tag'/);
    }
    assert.ok(!('pull_request_target' in workflow.on));
    assert.doesNotMatch(JSON.stringify(jobs.push.if), /pull_request/);
    assert.ok(
      !JSON.stringify(workflow).includes('secrets.'),
      'no repository secret; the token is github.token',
    );
  });

  it('AC-6 never puts an expression in a run: script (it goes through env)', () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const step of job.steps) {
        if (typeof step.run === 'string') {
          assert.ok(
            !step.run.includes('${{'),
            `${name}: ${step.run.slice(0, 60)}`,
          );
        }
      }
    }
  });
});
