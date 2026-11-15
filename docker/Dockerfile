# fmd-web image (DESIGN.md §11 docker/).
#
# Multi-stage: build (full workspace + tsc -b) → runtime (prod deps +
# dist trees, non-root `node` user, healthcheck stub).
#
# Base image is pinned to an exact Node LTS minor (DESIGN.md §3
# reproducibility). CI replaces this tag with its resolved
# @sha256:... digest and double-builds + SBOM-diffs to catch drift;
# keep the exact-minor form here so local builds stay deterministic.
FROM node:22.14.0-bookworm-slim AS build

WORKDIR /app

# Workspace manifests first for layer-cached installs.
COPY package.json package-lock.json ./
COPY contract/package.json contract/
COPY server/package.json server/
COPY corpus/package.json corpus/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

# Sources + build (project references build contract → server/corpus/web;
# the SPA bundle is built by vite into web/dist-web for the runtime layer).
COPY tsconfig.base.json tsconfig.json ./
COPY contract ./contract
COPY server ./server
COPY corpus ./corpus
COPY web ./web
RUN npm run build \
    && npm run build -w @fmd/web \
    && npm prune --omit=dev --no-audit --no-fund

FROM node:22.14.0-bookworm-slim AS runtime

# Release stamp (0.1.0): OCI image label + the composed fmd-web:<tag>
# name (compose.yml FMD_WEB_IMAGE_TAG, default `local`). Keep in sync
# with package.json + CHANGELOG.md — the release gate asserts it.
LABEL org.opencontainers.image.title="fmd-web" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.description="Dockerized web rebuild of FMD2 running FMD2's Lua site-module ecosystem and FMD2-DB catalogs unchanged (DESIGN.md v5)" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=3000 \
    FMD_WEB_DATA_DIR=/app/data

WORKDIR /app

# The base image needs no OS packages for sodium-native (it ships its own
# prebuilt libsodium binaries for linux-x64); the catalog 7z extractor
# (DESIGN.md §6.3) ships through node_modules (7zip-bin's per-platform
# 7za, §11 sync/db resolution order FMD_CATALOG_7ZZ → 7zz → 7za →
# 7zip-bin), so no apt layer is needed. A native-module smoke check runs
# at image build time below (crypto shim backends, DESIGN.md §5.7).
RUN mkdir -p /app/data \
    && chown node:node /app/data

COPY --from=build --chown=root:root /app/package.json ./package.json
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/contract/package.json ./contract/package.json
COPY --from=build --chown=root:root /app/contract/dist ./contract/dist
COPY --from=build --chown=root:root /app/server/package.json ./server/package.json
COPY --from=build --chown=root:root /app/server/dist ./server/dist
COPY --from=build --chown=root:root /app/corpus/package.json ./corpus/package.json
COPY --from=build --chown=root:root /app/web/package.json ./web/package.json
# SPA bundle (vite build outDir: dist-web — web/dist is the tsc output).
COPY --from=build --chown=root:root /app/web/dist-web ./web/dist-web

# Native backend smoke check (sodium-native for the crypto shim,
# DESIGN.md §5.7): fails the image build when the prebuilt libsodium
# binary does not load in the runtime layer.
RUN node -e "const s = require('sodium-native'); if (typeof s.crypto_scalarmult !== 'function') process.exit(1); console.log('sodium-native OK in docker target');"

# Catalog extractor smoke check (DESIGN.md §6.3): the docker-shipped 7z
# binary must resolve and run in the runtime layer.
RUN node -e "const fs = require('fs'); const p = require.resolve('7zip-bin/linux/x64/7za'); fs.accessSync(p, fs.constants.X_OK); require('child_process').execFileSync(p, ['--help'], { stdio: 'ignore' }); console.log('7z extractor OK in docker target:', p);"

# Non-root (official image ships the `node` user, uid 1000).
USER node

EXPOSE 3000
VOLUME /app/data

# Healthcheck stub against the placeholder /healthz endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SIGTERM → bounded drain (server/src/runtime-entry.ts, DESIGN §4).
# dist/src/ layout: the composite project emits src + test trees. The
# runtime serves the SPA from web/dist-web (FMD_STATIC_DIR) and gates
# /readyz on the D20 first-run bootstrap.
CMD ["node", "server/dist/src/runtime-entry.js"]
