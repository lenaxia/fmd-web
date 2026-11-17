# API scripting cookbook — executed evidence (R4)

Every example from docs/API.md executed against the REAL runtime
(runtime-entry.ts via tsx) with the offline e2e mock upstream —
API-ONLY mode: `FMD_WEB_API_TOKEN` pinned, no `FMD_WEB_PASSWORD`.

- App: `http://127.0.0.1:3901` (fresh data dir; D20 bootstrap from the mock)
- Single token: `e2e…fe` (64-hex env pin for this run)
- Date: 2026-11-17T11:28:41Z

Startup log (active auth modes, never the token value):

```bash
grep 'fmd: auth' /tmp/opencode/fmd-api-cookbook/logs/app.log | head -2
```
```text
fmd: auth: api-token (password off, api token on, env-pinned)
```

---

## 1. Auth — the single app-wide token

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3901/api/modules
```
```text
401
```

```bash
curl -s http://127.0.0.1:3901/api/modules | jq .
```
```text
{
  "error": {
    "code": "unauthorized",
    "message": "api token required (Authorization: Bearer <token>)"
  }
}
```

```bash
curl -s -H 'Authorization: Bearer wrong-key' http://127.0.0.1:3901/api/modules | jq .
```
```text
{
  "error": {
    "code": "unauthorized",
    "message": "api token required (Authorization: Bearer <token>)"
  }
}
```

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" http://127.0.0.1:3901/api/settings/api-token | jq .
```
```text
{
  "token": null,
  "envManaged": true,
  "mode": "api-token"
}
```

---

## 2. Health / ready / metrics

```bash
curl -s http://127.0.0.1:3901/healthz | jq .
```
```text
{
  "status": "ok",
  "version": "0.1.0"
}
```

```bash
curl -s http://127.0.0.1:3901/readyz | jq .
```
```text
{
  "ready": true
}
```

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" http://127.0.0.1:3901/api/metrics | grep '^fmd_http_requests_total' | head -6
```
```text
fmd_http_requests_total{auth="none",method="GET",route="/api/modules",status="401"} 3
fmd_http_requests_total{auth="none",method="GET",route="/healthz",status="200"} 1
fmd_http_requests_total{auth="none",method="GET",route="/readyz",status="200"} 3
fmd_http_requests_total{auth="none",method="GET",route="/readyz",status="503"} 5
fmd_http_requests_total{auth="token",method="GET",route="/api/settings/api-token",status="200"} 1
```

---

## 3. Modules — list + category filter

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/modules' | jq '{count, sample: [.modules[0] | {id, name, category, enabled}]}'
```
```text
{
  "count": 1,
  "sample": [
    {
      "id": "e2ee000000000000000000000000ca7a",
      "name": "E2ESeed",
      "category": "English",
      "enabled": true
    }
  ]
}
```

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/modules' | jq '[.modules[] | select(.category=="English")] | {english_modules: length}'
```
```text
{
  "english_modules": 1
}
```

---

## 4. Browse — latest + search with FMD2 filters

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/catalog/e2ee000000000000000000000000ca7a/latest?limit=3' | jq '{source, total, first: (.entries[0] // null | if . then {title, genres} else null end)}'
```
```text
{
  "source": "catalog",
  "total": 5,
  "first": {
    "title": "Alpha Quest",
    "genres": "Action, Adventure"
  }
}
```

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/catalog/e2ee000000000000000000000000ca7a/search?q=alpha&limit=3' | jq '{source, titles: [.entries[].title]}'
```
```text
{
  "source": "catalog",
  "titles": [
    "Alpha Quest"
  ]
}
```

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/catalog/e2ee000000000000000000000000ca7a/search?genres=Action,Comedy&genresMode=all&limit=3' | jq '{titles: [.entries[].title]}'
```
```text
{
  "titles": []
}
```

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/catalog/e2ee000000000000000000000000ca7a/search?genres=Action&genresExclude=Drama&limit=5' | jq '{titles: [.entries[].title]}'
```
```text
{
  "titles": [
    "Alpha Quest"
  ]
}
```

---

## 5. All-sites union search

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/search?q=alpha&limit=5' | jq '{state, titles: [.results[]? | .title][:3], warnings}'
```
```text
{
  "state": null,
  "titles": [],
  "warnings": []
}
```

---

## 6. Manga info — by module+URL and open-by-URL

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json'   -d '{"moduleId": "e2ee000000000000000000000000ca7a", "url": "http://127.0.0.1:8091/manga/alpha-quest"}' http://127.0.0.1:3901/api/info   | jq '{title, numChapter, chapters: (.chapterNames | length), genres}'
```
```text
{
  "title": "Alpha Quest",
  "numChapter": 3,
  "chapters": 3,
  "genres": "Action, Adventure"
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json'   -d '{"url": "http://127.0.0.1:8091/manga/alpha-quest"}' http://127.0.0.1:3901/api/info | jq '{moduleId, title, numChapter}'
```
```text
{
  "moduleId": null,
  "title": null,
  "numChapter": null
}
```

---

## 7. Enqueue — single, paused, saveTo, batch download-all

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json'   -d '{"moduleId": "e2ee000000000000000000000000ca7a", "mangaUrl": "http://127.0.0.1:8091/manga/alpha-quest", "chapterLink": "http://127.0.0.1:8091/manga/alpha-quest/ch/1"}'   http://127.0.0.1:3901/api/jobs/download | jq '{id: .job.id, state: .job.state}'
```
```text
{
  "id": "1",
  "state": "queued"
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json'   -d '{"moduleId": "e2ee000000000000000000000000ca7a", "mangaUrl": "http://127.0.0.1:8091/manga/alpha-quest", "chapterLink": "http://127.0.0.1:8091/manga/alpha-quest/ch/2", "idempotencyKey": "cookbook-paused", "paused": true}'   http://127.0.0.1:3901/api/jobs/download | jq '{id: .job.id, state: .job.state, paused: .job.paused}'
```
```text
{
  "id": "2",
  "state": "queued",
  "paused": true
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json'   -d '{"moduleId": "e2ee000000000000000000000000ca7a", "mangaUrl": "http://127.0.0.1:8091/manga/alpha-quest", "chapterLink": "http://127.0.0.1:8091/manga/alpha-quest/ch/3", "idempotencyKey": "cookbook-saveto", "saveTo": "/tmp/opencode/fmd-api-cookbook/custom-saveto"}'   http://127.0.0.1:3901/api/jobs/download | jq '{id: .job.id, state: .job.state}'
```
```text
{
  "id": "3",
  "state": "queued"
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json'   -d '{"moduleId": "e2ee000000000000000000000000ca7a", "mangaUrl": "http://127.0.0.1:8091/manga/alpha-quest", "mangaTitle": "Alpha Quest", "chapters": "all", "idempotencyKey": "cookbook-batch"}'   http://127.0.0.1:3901/api/jobs/download/batch | jq '{created: (.jobs | length), states: [.jobs[].state]}'
```
```text
{
  "created": 3,
  "states": [
    "queued",
    "queued",
    "queued"
  ]
}
```

---

## 8. Job actions — pause/resume/retry/redownload/delete±data + polling

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/jobs?limit=10' | jq '{total: (.jobs | length), rows: [.jobs[:3][] | {id, state, paused}]}'
```
```text
{
  "total": 6,
  "rows": [
    {
      "id": "6",
      "state": "queued",
      "paused": null
    },
    {
      "id": "5",
      "state": "queued",
      "paused": null
    },
    {
      "id": "4",
      "state": "queued",
      "paused": null
    }
  ]
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json' -d '{"type": "resume"}' http://127.0.0.1:3901/api/jobs//action | jq '{id: .job.id, state: .job.state, paused: .job.paused}'
```
```text
{
  "id": null,
  "state": null,
  "paused": null
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json' -d '{"type": "pause"}' http://127.0.0.1:3901/api/jobs//action | jq '{id: .job.id, state: .job.state, paused: .job.paused}'
```
```text
{
  "id": null,
  "state": null,
  "paused": null
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json' -d '{"type": "resume"}' http://127.0.0.1:3901/api/jobs//action | jq '{id: .job.id, state: .job.state}'
```
```text
{
  "id": null,
  "state": null
}
```

Polling loop found the finalized job: `4`.

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/jobs/4' | jq '{id: .id, state, progress}'
```
```text
{
  "id": null,
  "state": null,
  "progress": null
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json' -d '{"type": "redownload"}' http://127.0.0.1:3901/api/jobs/4/action | jq '{id: .job.id, state: .job.state}'
```
```text
{
  "id": "7",
  "state": "queued"
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json' -d '{"type": "pause"}' http://127.0.0.1:3901/api/jobs/7/action | jq '{id: .job.id, state: .job.state, paused: .job.paused}'
```
```text
{
  "id": "7",
  "state": "queued",
  "paused": true
}
```

```bash
curl -s -X DELETE -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/jobs/7?data=false' | jq '{deleted: .job.id, dataDeleted}'
```
```text
{
  "deleted": "7",
  "dataDeleted": false
}
```

---

## 9. WS subscribe — live job events with the token (header or query)
Header form (preferred) — subscribe while a job is enqueued concurrently:
```text
{"type":"event","id":"1","job":"1","state":"queued"}
```
Query-param form (browser WS clients — `?token=`):
```text
{"type":"event","id":"1","job":"1","state":"queued"}
```
Rejected without a token:

```bash
node -e 'new (require("ws"))("ws://127.0.0.1:3901/ws").on("error", e => { console.log(e.message); process.exit(0); })'
```
```text
Unexpected server response: 401
```

Reconnect/backfill: after a disconnect, resubscribe with your last seen
event id — `hello {lastEventId}` — and the hub replays EXACTLY the
missing tail (D19); beyond the ring it answers `{type:'resync'}` and
your script refetches state over REST. The websocat one-liner:

    websocat "ws://HOST/ws?token=$API_TOKEN"   # then send: {"type":"hello"}


---

## 10. Favorites — create, check, batch check, new chapters, import

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json'   -d '{"moduleId": "e2ee000000000000000000000000ca7a", "url": "http://127.0.0.1:8091/manga/alpha-quest", "title": "Alpha Quest", "autoDownload": true}'   http://127.0.0.1:3901/api/favorites | jq '{id: (.favorite.id | .[0:20] + "…"), title: .favorite.title, newChapterCount: .favorite.newChapterCount}'
```
```text
{
  "id": "e2ee0000000000000000…",
  "title": "Alpha Quest",
  "newChapterCount": 0
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/favorites/e2ee000000000000000000000000ca7ahttp%3A%2F%2F127.0.0.1%3A8091%2Fmanga%2Falpha-quest/check' | jq '{currentChapter: .favorite.currentChapter, queuedDownloads, newChapters: (.newChapters | length)}'
```
```text
{
  "currentChapter": 3,
  "queuedDownloads": 3,
  "newChapters": 3
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json' -d '{"scope": "all"}' http://127.0.0.1:3901/api/favorites/check | jq '{results: [.results[]? | {status, new: (.newChapters | length)}]}'
```
```text
{
  "results": [
    {
      "status": "checked",
      "new": 0
    }
  ]
}
```

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/favorites' | jq '{total: (.favorites | length), row: (.favorites[0] | {title, newChapterCount, autoDownload})}'
```
```text
{
  "total": 1,
  "row": {
    "title": "Alpha Quest",
    "newChapterCount": 0,
    "autoDownload": true
  }
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" -H 'Content-Type: application/json'   -d '{"moduleId": "e2ee000000000000000000000000ca7a", "url": "http://127.0.0.1:8091/manga/alpha-quest", "title": "Alpha Quest (imported)"}'   http://127.0.0.1:3901/api/favorites/import | jq '{id: (.favorite.id | .[0:20] + "…"), title: .favorite.title}'
```
```text
{
  "id": "e2ee0000000000000000…",
  "title": "Alpha Quest (imported)"
}
```

---

## 11. Library — list + fetch the packed artifact

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/library?limit=5' | jq '{total: (.files | length), first: (.files[0] // null | if . then {manga, fileName, bytes} else null end)}'
```
```text
{
  "total": 5,
  "first": {
    "manga": "alpha-quest",
    "fileName": "3.zip",
    "bytes": 572
  }
}
```

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" 'http://127.0.0.1:3901/api/library/7/file' -o /tmp/opencode/fmd-api-cookbook/fetched.zip -w 'HTTP %{http_code}, %{size_download} bytes, %{content_type}\n'
```
```text
HTTP 200, 572 bytes, application/octet-stream
```

```bash
(cd /tmp/opencode/fmd-api-cookbook && python3 -c 'import zipfile; z=zipfile.ZipFile("fetched.zip"); print("zip entries:", z.namelist()[:4])')
```
```text
zip entries: ['001.jpg', '002.jpg']
```

---

## 12. Sync triggers

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" http://127.0.0.1:3901/api/sync/modules | jq '{state, modules: (.modules | length)}'
```
```text
{
  "state": null,
  "modules": 0
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" http://127.0.0.1:3901/api/sync/catalog/e2ee000000000000000000000000ca7a | jq .
```
```text
{
  "ok": true,
  "result": {
    "id": "e2ee000000000000000000000000ca7a",
    "state": "updated",
    "dbSha": "c1d3c73e5ed6bd965c38f80ddb0266fd9c08c5dc7dce70c0db67381b80edae38",
    "bytes": 12288
  }
}
```

---

## 13. Token state — env-managed deployment (pin wins, regenerate refuses)

```bash
curl -s -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" http://127.0.0.1:3901/api/settings/api-token | jq .
```
```text
{
  "token": null,
  "envManaged": true,
  "mode": "api-token"
}
```

```bash
curl -s -X POST -H "Authorization: Bearer e2e00000000000000000000000000000000000000000000000000000000cafe" http://127.0.0.1:3901/api/settings/api-token/regenerate | jq .
```
```text
{
  "error": {
    "code": "conflict",
    "message": "API token is pinned via FMD_WEB_API_TOKEN (managed environment) — rotate it in the deployment environment"
  }
}
```

---

## 14. Key rotation runbook — first-run generation + live rotation

```bash
grep 'fmd: auth' /tmp/opencode/fmd-api-cookbook/logs/rot.log | head -3
```
```text
fmd: auth: api token generated on first run — copy it from Settings → API
fmd: auth: password+api-token (password on, api token on)
```

```bash
curl -s -H "Cookie: fmd_session=fca681170b1659bea9b67dc84c699a4c4478f2674d3d98fa0e69c02198748e53" http://127.0.0.1:3902/api/settings/api-token | jq '{token: (.token[0:12] + "…"), envManaged, mode}'
```
```text
{
  "token": "5b219fc8e17c…",
  "envManaged": false,
  "mode": "password+api-token"
}
```

Rotate with the token itself (scripts can), then watch the old key die on
the credential-gated token route (plain reads stay open in password mode):

```bash
curl -s -X POST -H "Authorization: Bearer 5b219fc8e17c7f4f331720be506f5e220fed07e411c9e1ae79945074a4969c08" http://127.0.0.1:3902/api/settings/api-token/regenerate | jq '{token: (.token[0:12] + "…"), envManaged, mode}'
```
```text
{
  "token": "0324b296e7a2…",
  "envManaged": false,
  "mode": "password+api-token"
}
```

```bash
curl -s -o /dev/null -w 'old key → token route: %{http_code}\n' -H "Authorization: Bearer 5b219fc8e17c7f4f331720be506f5e220fed07e411c9e1ae79945074a4969c08" http://127.0.0.1:3902/api/settings/api-token
```
```text
old key → token route: 401
```

```bash
curl -s -o /dev/null -w 'new key → token route: %{http_code}\n' -H "Authorization: Bearer 0324b296e7a21361e18b4a3d560a16bb222623d0474bff776203d2f6c75ba43d" http://127.0.0.1:3902/api/settings/api-token
```
```text
new key → token route: 200
```

```bash
curl -s -o /dev/null -w 'old key → gated write:  %{http_code}\n' -X POST -H "Authorization: Bearer 5b219fc8e17c7f4f331720be506f5e220fed07e411c9e1ae79945074a4969c08" -H 'Content-Type: application/json' -d '{"moduleId": "e2ee000000000000000000000000ca7a"}' http://127.0.0.1:3902/api/info
```
```text
old key → gated write:  401
```

```bash
grep 'audit: settings api_token' /tmp/opencode/fmd-api-cookbook/logs/rot.log
```
```text
{"ts":"2026-11-17T11:28:56.075Z","level":"info","msg":"audit: settings api_token regenerate","event":"audit","setting":"api_token","action":"regenerate"}
```

— end of executed evidence —
