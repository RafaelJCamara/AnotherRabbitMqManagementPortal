// What the image targets and the live tests share: the image name, and a way to ask whether a Docker
// daemon answers. No daemon means "nothing was proved" and says so loudly; DOCKER_REQUIRE=1 (CI)
// turns that into a failure, the way PERF_REQUIRE_BROWSER does for the browser runs.
import { execFileSync, spawnSync } from 'node:child_process';

/** The local tag `docker:build` makes and the live tests run. `DOCKER_IMAGE` overrides it. */
export const IMAGE = process.env.DOCKER_IMAGE ?? 'product-local';

/** True when `DOCKER_REQUIRE=1`: a skipped docker step is then a failure. */
export const required = (env = process.env) => env.DOCKER_REQUIRE === '1';

/**
 * Asks the daemon which kind of containers it runs: `docker info --format '{{.OSType}}'`, within
 * 20 s. Returns the exit status and the trimmed output (`undefined` status when `docker` could not
 * be started at all). Injected into `daemonProblem` so the decision can be tested without a daemon.
 */
export function runDockerInfo() {
  const result = spawnSync('docker', ['info', '--format', '{{.OSType}}'], {
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? undefined,
    stdout: String(result.stdout ?? '').trim(),
  };
}

/**
 * Why this machine cannot build or run the Linux image, or `undefined` when it can. Two cases:
 * no daemon answers, or the daemon runs another kind of container (the Windows runners of CI run
 * Windows containers, and the base images of the Dockerfile have no Windows manifest, so a build
 * there fails on the pull). The Linux image is built natively on Linux by `image.yml`.
 *
 * @param {() => { status: number | undefined, stdout: string }} run answers `docker info`
 */
export function daemonProblem(run = runDockerInfo) {
  const { status, stdout } = run();
  if (status !== 0) return 'no Docker daemon answers';
  if (stdout.toLowerCase() !== 'linux')
    return `the Docker daemon runs ${stdout === '' ? 'unknown' : stdout} containers and the image needs a daemon that runs linux containers`;
  return undefined;
}

/** True when a daemon answers and runs Linux containers. */
export const daemonAnswers = (run = runDockerInfo) =>
  daemonProblem(run) === undefined;

/**
 * What `docker:build` does: `build` when the daemon can, otherwise `skip` (message on stderr,
 * exit 0), or `fail` (same message, exit 1) when `DOCKER_REQUIRE=1`.
 *
 * @param {string | undefined} problem the result of `daemonProblem`
 * @param {NodeJS.ProcessEnv} env
 */
export function buildPlan(problem, env = process.env) {
  if (problem === undefined) return { action: 'build', exitCode: 0 };
  return {
    action: required(env) ? 'fail' : 'skip',
    message: skipped('build', problem),
    exitCode: required(env) ? 1 : 0,
  };
}

/** True when the image exists in the local daemon. */
export function imageExists(image = IMAGE) {
  try {
    execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** The line printed when a docker step is skipped for want of a daemon or an image. */
export const skipped = (what, why) =>
  `docker ${what} SKIPPED: ${why}. Nothing was proved. Run it where a Docker daemon answers (CI does), or set DOCKER_REQUIRE=1 to make this a failure.`;
