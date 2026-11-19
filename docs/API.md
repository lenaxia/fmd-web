# fmd-web API scripting cookbook (R4)

The REST/WS API is a first-class surface (docs/UX-PARITY.md R4): everything
the UI can do is API-reachable, and it stays that way. This cookbook is the
scripting manual — every example was EXECUTED against the real runtime and
the captured output lives in [docs/evidence-api-scripting.md](evidence-api-scripting.md).

Reference material:

- **OpenAPI snapshot** — `server/src/api/openapi.snapshot.json` (generated from the
  zod schemas; `GET /api/…` operations, request/response types, `securitySchemes`).
  Regenerate with `npm run api:snapshot`.
- **Typed client** — the SPA's client (`web/src/api/openapi.d.ts`) is generated from
  the same snapshot (`npm run gen:api -w @fmd/web`); scripts in TypeScript can do the
  same with `openapi-typescript`.
- **Runbook** — token lifecycle, env pinning and the token-only contract:
  [docs/runbook.md](runbook.md) § *API token (R4)*.

## Authentication — API key only

ONE token per deployment, Sonarr/Radarr-style: 32-byte hex, auto-generated on
the first start of EVERY unpinned deployment (an *arr-style script key),
manageable in **Settings → API** (masked key, reveal, copy, Regenerate),
optionally pinned via the `FMD_WEB_API_TOKEN` environment variable for
headless deployments. There are never multiple tokens, token lists, per-user
or per-scope tokens — if a future need sounds like "another token", the
answer is a regenerate of the single key.

The token is the app's ONLY credential (the optional-password mode was
REMOVED — owner decision 2026-11): the app performs no user authentication.
For user-facing auth, put **Authelia, Authentik or PocketID** in front via
your reverse proxy — that is the documented and supported pattern.

Send the key on every request:

```bash
TOKEN=e2e00000000000000000000000000000000000000000000000000000000cafe
BASE=http://localhost:3000

curl -H "Authorization: Bearer $TOKEN" "$BASE/api/modules"
```

### The one auth mode: open + API key (*arr auth-None semantics)

| API token | Effective behavior |
| --- | --- |
| active (always, once generated) | **Open deployment** — every `/api` route, state-changing POSTs included, and `/ws` answer without a credential (the SPA works login-free; front the app with a reverse proxy when you need a human gate). Scripts send the Bearer key, which is accepted everywhere. |

Facts that matter to scripts:

- `Authorization: Bearer <token>` is accepted on **every** `/api` route and the
  `/ws` upgrade (`?token=` query param works for browser WS clients that cannot
  set headers).
- A wrong key never locks you out (open is open) — it simply does not
  authenticate: the request is served as anonymous and labeled `auth="none"`.
- Verification is constant-time; the token never appears in logs, metrics or
  `GET /api/settings` (it lives only on `GET /api/settings/api-token`,
  readable by whoever can reach the app, exactly *arr's auth-None semantics —
  your reverse proxy owns that read in gated deployments).
- `/healthz` and `/readyz` are plain reads (Docker healthchecks).
- `fmd_http_requests_total{auth="none|token",…}` in `/api/metrics`
  counts every request by how it authenticated.

### Upgrading from password auth (BREAKING)

Instances that had a password set upgrade to token-only auth:
`FMD_WEB_PASSWORD` is no longer read, `POST /api/auth/login` is gone
(404), and old session cookies are ignored. The API token continues to
work unchanged — same value, same Bearer spelling. Humans who relied on
the password gate should front the app with a reverse proxy (see above).

## Cookbook

All examples assume `$BASE` and `$TOKEN` from above. Outputs are trimmed; the
full executed log with responses is [evidence-api-scripting.md](evidence-api-scripting.md).

### Health / ready / metrics

```bash
curl -s "$BASE/healthz" | jq .           # liveness — never gated
curl -s "$BASE/readyz" | jq .            # readiness (D20 bootstrap gate)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/metrics" | grep '^fmd_http_requests_total'
```

### Modules — list and filter

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/modules" \
  | jq '{count, first: .modules[0] | {id, name, category, enabled}}'

# category filter (jq — the site-picker facet server-side is per-catalog browse)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/modules" \
  | jq '[.modules[] | select(.category=="English")] | length'
```

### Browse — latest and search (FMD2 filter panel)

```bash
MOD=e2ee000000000000000000000000ca7a    # a module id (32-hex)

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/catalog/$MOD/latest?limit=20" | jq .
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/catalog/$MOD/search?q=alpha&limit=20" | jq .

# genre multi-select: any|all join, excludes (!-genres parity)
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/catalog/$MOD/search?genres=Action,Comedy&genresMode=all&limit=20" | jq .
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/catalog/$MOD/search?genres=Action&genresExclude=Drama&limit=20" | jq .
```

Cursor pagination: responses carry `nextCursor` — feed it back as `?cursor=…`.

### All-sites union search (scoped)

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/search?q=alpha&limit=20" \
  | jq '{scope, titles: [.entries[].title], warnings}'
```

Fans out over every installed catalog; failed sites surface in `warnings`
(typed partial state — a union search never fails wholesale). Repeated
identical pages are served from a short-TTL (30 s) cache.

**Scope** (D1 §2): `?scope=preferred` narrows to the preferred-sites
allowlist (facets render in its canonical order); an explicit `?sites=`
list (repeated or comma-separated params) is the tightest scope and wins
over the named one — unknown ids are a typed 400 naming them. The response
echoes the effective `scope`. The default (`all`) is answered from the
local index with **zero network** — catalog-less sites surface in
`excluded`, never a live scrape.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/search?q=alpha&scope=preferred" | jq '.scope'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/search?q=alpha&sites=<id1>&sites=<id2>" | jq '.scope'
```

### Preferred sites — the global allowlist

```bash
# Read the ordered allowlist (canonical order — fixes scope ordering,
# picker presentation order, duplicate-title resolution order):
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/preferred-sites" | jq '.sites'

# Replace it wholesale (the one write surface; the submitted order IS
# the next canonical order; unknown ids are a typed 400 naming them):
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sites": ["<id1>", "<id2>"]}' "$BASE/api/preferred-sites" | jq '.sites'
```

`GET /api/modules` rows carry `preferred: true` for members (joined live
per read). A PUT bumps the search cache generation so scoped pages never
serve a stale allowlist.

### Manga info — by id or open-by-URL

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"moduleId": "'$MOD'", "url": "https://example.org/manga/alpha-quest"}' \
  "$BASE/api/info" | jq '{title, numChapter, chapters: (.chapterNames | length)}'

# open-by-URL: the module is resolved by RootURL host (M14 parity)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url": "https://example.org/manga/alpha-quest"}' "$BASE/api/info" | jq '{moduleId, title}'
```

### Enqueue downloads

```bash
# single chapter
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"moduleId":"'$MOD'","mangaUrl":"https://example.org/manga/alpha-quest",
       "chapterLink":"https://example.org/manga/alpha-quest/ch/1"}' \
  "$BASE/api/jobs/download" | jq '{id: .job.id, state: .job.state}'

# add-as-stopped (cbAddAsStopped parity) — queues held until resume
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"moduleId":"'$MOD'","mangaUrl":"…","chapterLink":"…/ch/2",
       "idempotencyKey":"my-script-1","paused":true}' \
  "$BASE/api/jobs/download" | jq '{id: .job.id, state: .job.state, paused: .job.paused}'

# custom save-to directory (edSaveTo parity)
… -d '{"…","idempotencyKey":"my-script-2","saveTo":"/data/manga/manual"}' …

# batch download-all — ONE request per manga; REQUIRED idempotencyKey
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"moduleId":"'$MOD'","mangaUrl":"…","mangaTitle":"Alpha Quest",
       "chapters":"all","idempotencyKey":"batch-1"}' \
  "$BASE/api/jobs/download/batch" | jq '{created: (.jobs | length), states: [.jobs[].state]}'
```

Idempotency: replaying the same key with the same payload returns the original
job; the same key with a DIFFERENT payload is a `409`.

### Job actions and polling

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/jobs?state=queued&limit=20" | jq .
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/jobs/<id>" | jq .

# one typed union: pause | resume | retry | redownload | enable | disable
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"pause"}' "$BASE/api/jobs/<id>/action" | jq '.job.state'
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"redownload"}' "$BASE/api/jobs/<id>/action" | jq '.job.state'

# delete ± data (?data=true also removes the packed artifact)
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/jobs/<id>?data=false" | jq .
```

### Polling vs WS subscribe

Poll `GET /api/jobs` for snapshots; subscribe to `/ws` for live events:

```bash
# websocat one-liner (token via query param — browsers/CLI clients cannot set headers)
websocat "ws://localhost:3000/ws?token=$API_TOKEN"
# then send: {"type":"hello"}

# node (header form preferred)
node -e '
  const WebSocket = require("ws");
  const ws = new WebSocket("ws://localhost:3000/ws",
    { headers: { authorization: `Bearer ${process.env.API_TOKEN}` } });
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello" })));
  ws.on("message", (d) => console.log(String(d)));
'
```

Frames: `{type:"event", id, job}` job snapshots, `{type:"gap", fromId, toId}`
after a slow-consumer drop, `{type:"resync"}` when your cursor cannot be
reconstructed. **Reconnect/backfill**: on reconnect send
`{"type":"hello","lastEventId":"<last seen id>"}` — the hub replays EXACTLY the
missing tail (bounded ring: 1000 events / 15 min per job); beyond that you get
`resync` and refetch state over REST. Event ids are hub-global and strictly
increasing — store the last one you handled.

### Favorites

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"moduleId":"'$MOD'","url":"https://example.org/manga/alpha-quest",
       "title":"Alpha Quest","autoDownload":true}' \
  "$BASE/api/favorites" | jq '.favorite'

# check one favorite (immediate DoCheck cycle) — note the URL-ENCODED favorite id
FID=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/favorites" | jq -r '.favorites[0].id')
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/favorites/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$FID")/check" \
  | jq '{currentChapter: .favorite.currentChapter, queuedDownloads, newChapters: (.newChapters|length)}'

# batch check-all (the scheduler's manual trigger)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"scope":"all"}' "$BASE/api/favorites/check" | jq '.results'

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/favorites" \
  | jq '.favorites[] | {title, newChapterCount, autoDownload}'

# import (one row; loop your FMD2 export)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"moduleId":"'$MOD'","url":"…","title":"Alpha Quest (imported)"}' \
  "$BASE/api/favorites/import" | jq '.favorite'
```

### Import from FMD2 (the desktop app's own files)

Two phases: `analyze` parses the upload read-only and returns a preview
(favorites by site, unmapped catalog ids, mappable settings, detected
credential FIELDS — never values) plus a token; `apply` performs the
confirmed import. Credentials are opt-in (`credentials: [...]`) and default
OFF. Re-running apply on the same data is idempotent — favorites upsert by
module id + canonical URL, never duplicate.

```bash
# phase 1 — multipart: favorites.db / downloadedchapters.db / settings.json /
# modules.json / config.json, or a zip of the FMD2 data dir (100MB/file cap)
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -F 'file=@favorites.db' -F 'file=@settings.json' \
  "$BASE/api/import/fmd2/analyze" > /tmp/preview.json
jq '{favorites: .favorites.importable, unmapped: .favorites.unmappedSiteIds,
     settings: [.settings.mappable[].key], token: .analyzeToken}' /tmp/preview.json

# phase 2 — the token from analyze (no re-upload); pick selections
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"token":"'"$(jq -r .analyzeToken /tmp/preview.json)"'",
       "favorites":true,
       "settings":["proxy","performance","favorites-scheduler"],
       "credentials":[]}' \
  "$BASE/api/import/fmd2/apply" \
  | jq '{created: .favorites.created, updated: .favorites.updated,
         skipped: (.favorites.skipped|length),
         notImported: (.settings.notImportable|length)}'
```

### Library — finalized chapters

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/library?limit=50" \
  | jq '.files[] | {manga, fileName, bytes}'

FID=<file id>
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/library/$FID/file" -o chapter.zip
```

### Sync triggers

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/sync/modules" | jq .
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/sync/catalog/$MOD" | jq .
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/sync/catalog/all" | jq .
```

## Reverse-proxy / scripts-first recipe

Headless/compose deployment where scripts (and/or a reverse proxy's
auth) are the consumer — this is now the ONLY deployment shape:

```yaml
# compose (env pin — the token NEVER enters the settings store)
environment:
  FMD_WEB_API_TOKEN: ${FMD_WEB_API_TOKEN}
```

- The deployment is **open**: every `/api` route, state-changing POSTs
  included, and `/ws` answer without a credential (`/healthz` +
  `/readyz` are plain reads). Scripts send the Bearer key anyway — it
  is accepted everywhere.
- `GET /api/settings/api-token` reports `{"token":null,"envManaged":true}`
  — the UI shows "Managed via environment" and hides Regenerate.
- Without the env pin a token is still generated on first run (script
  key): read it from Settings → API or `GET /api/settings/api-token`,
  then front the app with your proxy's auth (Authelia/Authentik/
  PocketID/basic-auth) when humans need a gate — the token read is
  reachable by anyone who can reach the app, exactly *arr's auth-None
  semantics.
- Everything in this cookbook works with the token alone — that is
  exactly how the evidence run was executed.

## Key-rotation runbook (regenerate → update scripts)

1. Fetch/confirm the current key: Settings → API (copy button), or
   `GET /api/settings/api-token`.
2. Rotate:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $OLD_TOKEN" \
     "$BASE/api/settings/api-token/regenerate" | jq .token
   ```
   (or the Regenerate button — confirm dialog: *"Revokes the current key
   immediately — update your scripts"*). Rotation is a script-key
   operation (*arr semantics).
3. The OLD key stops authenticating its presenter on the very next
   request; the rotation is audit-logged as
   `{"event":"audit","setting":"api_token","action":"regenerate"}` — the log
   never carries the value.
4. Update every script/env that carried the old key. Env-pinned deployments
   rotate by changing the environment instead (the endpoint refuses with
   `409` while pinned).

## Limits and notes

- One 32-byte-hex token per deployment — regenerate to rotate; there is no
  second token, expiry schedule or scoping (permanent non-goal, R2/R4).
- The token settings route is readable by whoever can reach the app
  (auth-None parity — put a proxy in front when that matters).
