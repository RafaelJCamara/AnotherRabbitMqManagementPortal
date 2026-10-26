// `pnpm nx run docker:build`: builds the image for this machine's architecture and tags it
// `product-local` (DOCKER_IMAGE overrides). The Dockerfile builds the engine and the web app itself,
// from the lockfile, so nothing from the working tree's node_modules or dist goes in.
//
// Without a Docker daemon this prints that it proved nothing and exits 0; with DOCKER_REQUIRE=1 it
// exits 1. The multi-architecture build, the signing, the SBOM and the scan are the job of
// `.github/workflows/image.yml`, not of this command.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { IMAGE, daemonAnswers, required, skipped } from './daemon.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const command = process.argv[2];

if (command !== 'build') {
  process.stderr.write('usage: node packaging/docker/docker-tool.mjs build\n');
  process.exit(64);
}

if (!daemonAnswers()) {
  process.stderr.write(`${skipped('build', 'no Docker daemon answers')}\n`);
  process.exit(required() ? 1 : 0);
}

const built = spawnSync(
  'docker',
  ['build', '--file', 'packaging/docker/Dockerfile', '--tag', IMAGE, '.'],
  { cwd: root, stdio: 'inherit' },
);
process.exit(built.status ?? 1);
