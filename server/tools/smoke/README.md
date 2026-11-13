# Nightly live smoke harness (skeleton)

DESIGN.md §13: a rotating module-sample runner that exercises real site
modules over the LIVE network and emits a per-module pass-rate JSON
report. This is a MANUAL/nightly tool — **CI never runs it**: the
zero-network vitest guard forbids external sockets in tests, and
`scripts/ci.sh` never passes `--live`.

## Network gate

Nothing touches the network unless `--live` is passed explicitly:

- Without `--live` the CLI prints the rotation **plan** only (which
  modules the next run would sample). No engine session, no resolver,
  no sockets.
- `runSmokeModules` (the core) additionally refuses to run unless the
  caller constructs it with `{ live: true, resolver }` — the flag is
  enforced twice (CLI + core), and the only live resolver in the repo
  (`live-resolver.ts`) is reachable solely from this CLI.
- The live resolver shells out to a synchronous `curl -L` (the §5.4 Lua
  facade is synchronous), so the fetch happens on the worker thread of
  the CLI process — no async/socket in the offline paths.

## Usage

```bash
# plan only (offline — what would tonight's sample be?)
npx tsx server/tools/smoke/run.ts

# tonight's rotating sample (default 5 modules, UTC-day rotation)
npx tsx server/tools/smoke/run.ts --live --out /tmp/opencode/smoke.json

# pin a module and override its event URL (seed URLs are homepages;
# GetInfo needs a series URL on Madara-family sites)
npx tsx server/tools/smoke/run.ts --live --module ManhwaIndo \
    --url "https://manhwaindo.id/manga/solo-leveling/"

# sample size + explicit rotation index (reproducible runs)
npx tsx server/tools/smoke/run.ts --live --sample 3 --rotation-index 11
```

Flags: `--live` (network gate) · `--module A,B` (pin; comma-separated,
repeatable) · `--sample N` (default 5) · `--rotation-index N` (default
UTC day number) · `--seed-dir` (default `corpus/fixtures/seed`) ·
`--url` (override the event URL for every sampled module) · `--out PATH`
(also written to stdout).

Exit codes: `0` — plan printed or report produced (failures are IN the
report; the exit code does not gate on live-site health); `2` — usage
error.

## Rotation scheme

The seed corpus (`corpus/fixtures/seed/`, ≥50 modules with manifests)
is sorted by name; the sample is the `sampleSize`-wide window starting
at `(rotationIndex * sampleSize) mod total`, wrapping. With one run per
night and the default rotation index (UTC day number) consecutive
nights walk the whole corpus without repeating the same slice
back-to-back.

## Per-module pass-rate JSON

```json
{
  "generatedAt": "2026-11-13T17:26:23.969Z",
  "live": true,
  "rotationIndex": -1,
  "sampleSize": 1,
  "seedTotal": 1,
  "moduleResults": [
    {
      "module": "ManhwaIndo",
      "moduleFile": "modules/ManhwaIndo.lua",
      "moduleId": "5c8d90b0c6bc8385e6b96a13a1c19c76",
      "url": "https://manhwaindo.id/manga/solo-leveling/",
      "events": [
        {
          "event": "GetInfo",
          "url": "https://manhwaindo.id/manga/solo-leveling/",
          "status": "pass",
          "resultCode": 0,
          "detail": "title=\"\" chapters=0"
        }
      ],
      "passRate": 1,
      "durationMs": 3140
    }
  ],
  "passRate": 1
}
```

Pass semantics (skeleton): one `GetInfo` dispatch per module. **pass** =
the dispatcher returned the `no_error` code, no host error-level log
record fired during the dispatch, and the MANGAINFO facade read back
without throwing. A module/site legitimately returning empty data is a
pass whose `detail` shows the derived title/chapter count — the report
is observability, not a compatibility gate (the offline corpus runner
owns the ≥99% gate). **fail** = dispatch failure, non-zero net status,
host error log, missing module file, or a thrown setup error.

## Manual verification log

| Date | Command | Outcome |
|---|---|---|
| 2026-11-13 | `run.ts --sample 3` (no `--live`) | Plan-only JSON printed (AsmHentai, AsuraScans, BacaKomik), exit 0, no network — vitest no-network guard stays green in plan mode. |
| 2026-11-13 | `run.ts --live --module MangaDex` | Live run completed; honest FAIL — GetInfo needs a series UUID, the seed URL is the browse API (`attempt to concatenate a nil value (local 'mid')`). |
| 2026-11-13 | `run.ts --live --module AsuraScans` | Live run completed; honest FAIL — Madara-family GetInfo needs a `/series/<slug>` URL (`local 'slug'`), homepage seed URL lacks it. |
| 2026-11-13 | `run.ts --live --module ManhwaIndo --url https://manhwaindo.id/manga/solo-leveling/` | **PASS** — real series URL fetched LIVE through the curl resolver, GetInfo dispatched through the contract dispatcher, net status 0, MANGAINFO read back (empty title/chapters = the site's actual response to this parse pass — observability detail, not an error). |
| 2026-11-13 (post-§5.4 landing) | `run.ts --live --module ManhwaIndo --url https://manhwaindo.id/manga/solo-leveling/` | **PASS** — re-verified against the landed full-§5.4 shim: the resolver is now single-hop and the §5.4 pipeline owns redirect/retry; live fetch → dispatch → parse all clean. |
| 2026-11-13 (post-§5.4 landing) | `run.ts --live --module ManhwaIndo --url http://manhwaindo.id/manga/solo-leveling/` | **PASS** — the seed URL is deliberately non-TLS (site answers 301): the §5.4 pipeline followed the redirect live and the module completed with no_error — redirect-follow verified against a real site, not just the mock server. |

## Files

- `rotation.ts` — seed listing + deterministic window sampling (pure).
- `live-resolver.ts` — curl argv builder, header-dump parser, the
  `LiveResponseResolver` (satisfies the §5.4 shim resolver protocol via
  sync single-hop `curl --compressed`, temp-file bodies, status 0
  on transport failure — the Pascal failure shape; ONE HOP: the §5.4
  pipeline owns redirect-follow/retry semantics at FMD2 parity and
  calls back into the resolver per hop).
- `smoke.ts` — the run core: session per module (real Lua host + shims +
  contract dispatcher), GetInfo classification, report assembly. Gate:
  refuses without `{ live: true, resolver }`.
- `run.ts` — the CLI (plan mode / live mode).

Unit tests: `server/test/tools/smoke.test.ts` (offline; the network
gate itself is asserted — `runSmokeModules` rejects without the live
construction).
