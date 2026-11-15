# Image pinning, SBOM, and reproducibility (DESIGN.md §3)

The fmd-web images are built from exact-minor-pinned bases whose
resolved digests CI swaps in and SBOM-diff across double builds. This
document is the procedure + the currently recorded pins.

## Base images

| Image | Tag (Dockerfile) | Multi-arch index digest | linux/amd64 digest |
|---|---|---|---|
| `library/node` | `22.14.0-bookworm-slim` | `sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b` | `sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de` |

## Third-party compose services

| Image | Tag (compose) | Multi-arch index digest | Resolved |
|---|---|---|---|
| `ghcr.io/flaresolverr/flaresolverr` | `v3.3.21` (`--profile browser`, §5.11) | `sha256:f104ee51e5124d83cf3be9b37480649355d223f7d8f9e453d0d5ef06c6e3b31b` | 2026-11-15 |

Verify the flaresolverr pin (ghcr token flow; scripts/compose-check.sh
re-checks freshness when the docker CLI + network are available):

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:flaresolverr/flaresolverr:pull" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json" \
  https://ghcr.io/v2/flaresolverr/flaresolverr/manifests/v3.3.21 \
  | grep -i docker-content-digest
```

Both digests were resolved from `registry-1.docker.io` at
2026-11-13 (token-authenticated manifest fetch of the tag; the index
digest covers every platform, the amd64 digest pins one). Verify:

```sh
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" \
  https://registry-1.docker.io/v2/library/node/manifests/22.14.0-bookworm-slim \
  | grep -i docker-content-digest
```

- **App image** (`docker/Dockerfile`): keeps the human-readable
  `FROM node:22.14.0-bookworm-slim` so local builds stay deterministic
  and readable; CI replaces the tag with its resolved `@sha256:` digest
  at build time and FAILS when the digest drifts from this file.
- **Mock container** (`docker/compose.e2e.yml`): pinned by digest
  directly (`node:22.14.0-bookworm-slim@sha256:1c18d9ab…`) — the e2e
  fixture container must be byte-reproducible without a custom image.

## Digest recording (per build — scripts/e2e.sh does this)

```sh
docker image inspect fmd-web:local --format '{{.Id}}'            # image config digest
docker image inspect fmd-web:local --format '{{json .RepoDigests}}'  # registry digests after push
```

Artifacts land in `e2e/.tmp/artifacts/` (`image-id.txt`,
`image-repo-digests.json`) when e2e.sh runs in compose mode.

## SBOM procedure

CI (and any operator verifying supply-chain posture) runs:

```sh
syft fmd-web:local -o spdx-json > fmd-web.sbom.spdx.json
# double-build SBOM diff: two independent builds of the same source
# tree must produce IDENTICAL dependency inventories; a diff = drift
# (base image moved, or a dependency resolved non-reproducibly).
syft fmd-web:local-2 -o spdx-json > fmd-web-2.sbom.spdx.json
diff <(jq -S '.' fmd-web.sbom.spdx.json) <(jq -S '.' fmd-web-2.sbom.spdx.json)
```

- The runtime layer ships **no OS packages** (no apt layer): sodium-native
  and 7zip-bin carry their own prebuilt binaries, smoke-checked at image
  build (`RUN node -e …` gates in the Dockerfile), so the SBOM's OS
  component list is exactly the base image's.
- The production dependency set is the npm prune output (`--omit=dev`,
  lockfile-pinned via `npm ci`), so the SBOM dependency list is
  byte-stable across rebuilds of the same `package-lock.json`.

## Compose-leg validation (`scripts/compose-check.sh`)

`scripts/e2e.sh` validates the e2e compose overlay with the REAL docker
compose implementation in BOTH modes: `docker compose config` renders
and merges `docker/compose.yml` + `docker/compose.e2e.yml` client-side
(env_file interpolation, profiles, `depends_on` conditions, healthcheck
overrides — no daemon needed), and the script asserts the effective
config: mock ordering (`service_healthy`), `stop_grace_period: 30s`,
`restart: "no"`, published 3000, app env (from the prep-generated
`e2e.env`), the digest-pinned mock image, test profile, bind-mount
existence, the Dockerfile contract (non-root `USER node`, HEALTHCHECK,
CMD → built runtime entry, COPY sources present), and the pin's
freshness resolved live against the registry. It uses the host docker
CLI on docker hosts, or the vendored static CLI
(`e2e/.tmp/bin/docker/docker` + `cli-plugins/docker-compose`, pinned
docker 27.5.1 / compose v2.32.4 — authoring-time download, gitignored).
Compose mode (`--mode compose`) requires the validation to pass. To
vendor it:

```sh
mkdir -p e2e/.tmp/bin/cli-plugins && cd e2e/.tmp/bin
curl -fsSL -o docker-cli.tgz \
  https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz
tar -xzf docker-cli.tgz docker/docker && rm docker-cli.tgz
curl -fsSL -o cli-plugins/docker-compose \
  https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64
chmod +x cli-plugins/docker-compose
DOCKER_CONFIG="$PWD" ./docker/docker compose version
```

## Status in this environment

The authoring environment has no docker daemon (no `docker.sock`, no
`docker` binary, unprivileged user, user namespaces disabled by
`unshare` probe), so `scripts/e2e.sh` runs its **process-mode twin**
(same fixtures, same mock script, same runtime entry, same Playwright
specs) — and validates the compose leg with the real compose
implementation via `scripts/compose-check.sh` (above). What remains
daemon-execution-only: the image build and the container lifecycle —
the first docker-enabled run executes them mechanically (`compose build
→ up → exec id → stop -t 35 → logs/inspect` all scripted); the SBOM
commands below run there too.
