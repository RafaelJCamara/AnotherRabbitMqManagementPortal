// What the image targets and the live tests share: the image name, and a way to ask whether a Docker
// daemon answers. No daemon means "nothing was proved" and says so loudly; DOCKER_REQUIRE=1 (CI)
// turns that into a failure, the way PERF_REQUIRE_BROWSER does for the browser runs.
import { execFileSync, spawnSync } from 'node:child_process';

/** The local tag `docker:build` makes and the live tests run. `DOCKER_IMAGE` overrides it. */
export const IMAGE = process.env.DOCKER_IMAGE ?? 'product-local';

export const required = () => process.env.DOCKER_REQUIRE === '1';

/** True when `docker info` answers within 20 s. */
export function daemonAnswers() {
  const result = spawnSync(
    'docker',
    ['info', '--format', '{{.ServerVersion}}'],
    {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return result.status === 0;
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
