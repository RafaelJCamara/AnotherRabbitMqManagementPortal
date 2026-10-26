# docker

The container image of the single-user web app (M0-64, PLAT-09, ADR-016): a distroless, non-root, read-only-friendly image that runs the engine bundle in container mode, a compose file for it, and the workflow that builds, scans, publishes and signs it.

Tags: `type:tooling`, `runtime:node`. Plain Node, no dependencies of its own (the static checks read the workflow and the compose file with `yaml`, owned by the workspace).

## Files

| File | What it is |
| --- | --- |
| `Dockerfile` | Two stages. `build` (`node:24.22.0-trixie-slim`, pinned by digest) installs from the lockfile with the pnpm that `packageManager` pins and builds `engine` and `web`. `runtime` (`gcr.io/distroless/nodejs24-debian13:nonroot`, pinned by digest) holds the bundle in `/app/engine`, the web build in `/app/web/browser` (where the engine looks for it), `healthcheck.mjs`, the licence files in `/licenses` and an empty `/data` owned by uid 65532. No shell, no source map, no secret. |
| `Dockerfile.dockerignore` | The build context: no `node_modules`, `dist`, git data, env files or keys. BuildKit reads it before any root `.dockerignore`. |
| `compose.yaml` | The single-user run: port on `127.0.0.1` only, read-only root filesystem, `/tmp` as tmpfs, no capability, no privilege gain, token and key as secret files, data in a named volume. |
| `dockerfile.mjs`, `daemon.mjs`, `docker-tool.mjs` | A small Dockerfile reader for the checks, the daemon probe, and the `docker:build` command. |
| `dockerfile.test.mjs` | The static checks (no daemon): pins, user, stages, runtime contract, build context, compose, the image workflow. |
| `image.live.test.mjs` | The live checks (need a daemon and the built image). |
| `../../.github/workflows/image.yml` | Native amd64 and arm64 builds, the docker tests, Trivy, then (tag or manual publish, with the `IMAGE_NAME` repository variable set) push by digest with SBOM and provenance, one manifest list, cosign keyless signature and its verification. |

The `HEALTHCHECK` client is `apps/engine/scripts/healthcheck.mjs` (M0-59), copied into the image; there is one source.

## Run it

```sh
pnpm nx run docker:build                                  # builds `product-local` for this machine
docker run -p 127.0.0.1:8765:8765 --read-only --tmpfs /tmp -v app-data:/data product-local
docker compose -f packaging/docker/compose.yaml up --build   # the same, with secret files (see the header of compose.yaml)
```

Publish on `127.0.0.1` only (ADR-016). The engine prints the launch URL, with the token in the fragment, to the container log. `docker stop` sends SIGTERM; the engine drains and exits 0 within 2 s.

## Invariants

- I-1, I-12: one published port, loopback only; the image makes no call of its own and holds no updater or reporter (the engine's egress smoke covers the bundle; `--network none` is a live test here).
- I-10: no secret in the image, its environment or the compose file; the token and key are files. A misspelt `APP_*` variable is a usage error that does not print the value.
- Pins: both base images by tag and digest; the pnpm version from `package.json`; every action by full SHA.
- Nothing is published until the maintainer sets the `IMAGE_NAME` repository variable (the product name is pending, ADR-029, A-22).

## Proof commands

| Command | What it proves |
| --- | --- |
| `pnpm nx run docker:test` | The static checks always; the live checks when a Docker daemon answers and the image exists (it builds first). Without a daemon the live checks print `SKIPPED ... Nothing was proved` and pass; `DOCKER_REQUIRE=1` makes that a failure. |
| `pnpm nx run docker:build` | Builds the image (same skip rule). |
| `pnpm nx run supply-chain:actions-pinned` | Every action in `image.yml` is pinned by SHA. |

Not covered by anything in this folder: the multi-architecture manifest, the signature, the SBOM and provenance attestations and the Trivy scan are steps of `image.yml` and are proved by a workflow run (a tag or a manual publish on the repository).

## Bumping a base image

Read the multi-architecture index digest from the registry for the new tag, change tag and digest together in the `FROM` line, run `pnpm nx run docker:test`, and let the image workflow scan it. The distroless image carries its own Node patch version; the `engines` field (`>=24.15`) is the contract.
