# The container image (M0-64, PLAT-09, ADR-016). Build it from the repository root:
#
#   docker build -f packaging/docker/Dockerfile -t product-local .
#
# or with `pnpm nx run docker:build`. Two stages:
#
#   build    node:24-trixie-slim builds the engine bundle and the web app with the repository's own
#            pins (the lockfile, the pnpm in package.json). Nothing from this stage reaches the
#            runtime stage except the files copied explicitly below.
#   runtime  distroless nodejs24-debian13, nonroot. No shell, no package manager, no root user. The
#            engine bundle is self-contained (every npm package is bundled; only Node built-ins are
#            imported at run time), so the image holds the bundle, the web build, the healthcheck,
#            the licence files and an empty /data.
#
# Both base images are pinned by digest (a tag alone can move). To bump one, read the multi-arch
# index digest from the registry, change tag and digest together, and run `pnpm nx test docker`.
# Renovate's docker manager reads these two lines.
#
# Run it (docs/runbooks/run-locally.md has the long form). Publish on loopback only (ADR-016):
#
#   docker run -p 127.0.0.1:8765:8765 --read-only --tmpfs /tmp -v app-data:/data <image>
#
# The engine prints the launch URL and the exact `docker run` line to the container log.

FROM node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c AS build

# No Nx daemon, no cloud cache, no update check: the build makes no call but the package downloads
# of `pnpm install` (the lockfile pins every tarball by integrity).
ENV NX_DAEMON=false \
    NX_NO_CLOUD=true \
    CI=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /src
COPY . .

# pnpm at exactly the version `packageManager` pins, never a floating one.
RUN npm install --global --ignore-scripts "pnpm@$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '')")"

RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store

RUN pnpm nx run-many -t build -p engine web --skip-nx-cache

# The runtime tree. Source maps and the esbuild metafile stay behind (they hold build paths).
# /out/data is empty; the runtime stage copies it with the right owner.
RUN mkdir -p /out/app/web /out/data /out/licenses \
    && cp -r dist/apps/engine /out/app/engine \
    && cp -r dist/apps/web/browser /out/app/web/browser \
    && cp apps/engine/scripts/healthcheck.mjs /out/app/engine/healthcheck.mjs \
    && cp LICENSE NOTICE /out/licenses/ \
    && cp dist/apps/web/3rdpartylicenses.txt /out/licenses/web-3rdpartylicenses.txt \
    && find /out/app -type f \( -name '*.map' -o -name 'meta.json' \) -delete

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8 AS runtime

LABEL org.opencontainers.image.title="<Product> for RabbitMQ" \
      org.opencontainers.image.description="A workbench and control plane for RabbitMQ. RabbitMQ is a trademark of Broadcom, Inc. This project is not affiliated with, endorsed by, or sponsored by Broadcom, Inc." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="The <Product> Authors"

# APP_RUNTIME=container switches on the ADR-016 mode: the engine binds 0.0.0.0:8765 inside the
# container namespace, the launch token is mandatory, and exposure is decided by `-p 127.0.0.1:...`.
# Every other APP_* setting has its default (data in /data, port 8765); an unknown APP_* name is a
# usage error, so nothing else is set here. No secret is baked into the image.
ENV NODE_ENV=production \
    APP_RUNTIME=container

# The application is root-owned and read-only to the engine; only /data is writable.
COPY --from=build /out/app /app
COPY --from=build /out/licenses /licenses
COPY --from=build --chown=65532:65532 /out/data /data

WORKDIR /app
USER 65532:65532
VOLUME ["/data"]
EXPOSE 8765

# Exec form: this image has no shell. The client asks /healthz on 127.0.0.1 (APP_PORT or 8765).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["/nodejs/bin/node", "/app/engine/healthcheck.mjs"]

# SIGTERM reaches the engine as PID 1; it drains within 2 s and exits 0. Flags may follow the image
# name (for example --log-level=debug).
ENTRYPOINT ["/nodejs/bin/node", "/app/engine/main.mjs", "--mode=local"]
