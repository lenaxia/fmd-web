# Evidence — [subtle-honeycomb-endures] ComicInfo + rename template + scan-target guarantees

Story: make the library a perfect Komga/Kavita scan target. (1) the
FROZEN default filename template `<numbering> <chapter>` over the
ALREADY-PORTED FMD2 token system, with the tokens exposed as server
settings and NO chapter-number parsing anywhere (grep-gate); (2)
ComicInfo.xml embedded in cbz/zip output (Series = folder name, Title
= chapter label, a source/website field; deliberately NO
Number/Volume); (3) scan-target guarantees pinned by tests (atomic
appearance at the final path, `.cbz` extension, no dotfiles/temp
residue in the library root) + a generated fixture verifying the
whole convention. Charter: D1 §2 EXIT, §3 invariants, §7 numbering &
tokens, §8 standing constraints.

## What shipped (files)

| File | Role |
|---|---|
| `server/src/jobs/library/filenames.ts` | `DEFAULT_CHAPTER_NAME_TEMPLATE = '%NUMBERING% %CHAPTER%'` (the FROZEN D1 §7 decision, one exported constant shared by the zod default, the lane fallback and the tests) + `formatChapterNumbering(position, digitPadding)` — FMD2 `Format('%.4d', [i+1])` parity (uSilentThread.pas:338, minimum width 4) widened by the existing digit-padding setting (D1 §7: "the existing digit-padding setting governs the minimum width"). An absent position yields `''` (unknown position → chapter-name-only filename). |
| `server/src/jobs/queue/payloads.ts` | `chapterPosition` on `DownloadChapterJobSchema`: the 1-based list ordinal rides the job payload from enqueue time — FMD2 parity (the silent thread assigns numbering while building the task from MangaInfo), never re-derived at pack time (the list may drift; identity stays enqueue-frozen). |
| `server/src/jobs/packers/comic-info.ts` (NEW) | The ComicInfo.xml builder: Series/Title/Web/Notes only, XML-escaped, empty optionals omitted. NO Number/Volume — D1 §5 killed chapter-number parsing and the readers parse the positional filename prefix better than a guessed comic-number field (pinned by test). |
| `server/src/jobs/packers/types.ts` | `PackOptions.comicInfo?: ComicInfoInput` — the structured metadata seam. |
| `server/src/jobs/packers/zip-packer.ts` | Embeds ComicInfo.xml as the FIRST archive entry (STORE) ahead of the pages when the option is present. |
| `server/src/runtime/download-lane.ts` | (a) `RuntimeJobService.createDownload` forwards `chapterPosition` into the queue payload; (b) the pack/finalize block REORDERED — filename resolution + effective folder now run BEFORE the pack so ComicInfo Series equals the final series folder by construction (archive and library path can never disagree); (c) `numbering: formatChapterNumbering(payload.chapterPosition, output.digitPadding)` in the template resolution (was `''` — the token never resolved before this story); (d) the pack call carries `comicInfo {series: <effective folder or saveTo basename>, title: chapter label, web: manga URL, notes: website label}` for zip/cbz; (e) the seam-absent fallback defaults are the frozen pair (cbz + `%NUMBERING% %CHAPTER%`). |
| `server/src/jobs/favorites/engine.ts` | Auto-download enqueues carry `chapterPosition: chapter.position + 1` — the link-keyed diff already knows the live-list index. |
| `server/src/api/schemas.ts` | `OutputDefaultsSchema.format` default `zip`→`cbz` (the scan-target convention, D1 §3), `chapterNameTemplate` default `''`→`DEFAULT_CHAPTER_NAME_TEMPLATE`, doc rewritten (token vocabulary + the FROZEN note: later default changes require a migration event); `JobCreateRequestSchema.chapterPosition` (optional int ≥ 1). |
| `server/src/api/services.ts` | `JobCreateInput.chapterPosition` + the in-memory createDownload payload spread. |
| `server/src/api/app.ts` | `resolveChapterPosition` — the single-chapter endpoint resolves an omitted position through the SAME cached §5.8 info path the batch endpoint uses (best effort: fetch failure or an unknown link → no position, the enqueue is never blocked); explicit `chapterPosition` short-circuits the lookup; the batch endpoint assigns `index + 1` (the resolved/selected list IS the numbering authority). |
| `server/src/api/openapi.ts`, `routes.ts` | Descriptions: the frozen default + token vocabulary + the chapterPosition semantics; snapshot + web client regenerated over the merged surface (62dcd4e + this story) in an isolated tree — §8.2. |
| `web/src/components/OutputDefaultsForm.tsx` | DEFAULTS mirror flip (cbz + the frozen template) + the placeholder/hint carry the token vocabulary with the `%NUMBERING%` semantics. |
| `scripts/no-chapter-number-parsing-gate.sh` (NEW) + `scripts/ci.sh` | The grep-gate (details below), wired into the release gate after design-gate. |
| Tests | `server/test/jobs/packers/comic-info.test.ts` (7), `server/test/jobs/library/numbering.test.ts` (4), `server/test/jobs/library/komga-scan-target.test.ts` (2, the generated fixture), `server/test/runtime/download-lane-output.test.ts` (+1 end-to-end), `server/test/api/jobs.test.ts` (+4), `server/test/api/jobs-batch.test.ts` (+2 asserts), `server/test/api/settings.test.ts` (defaults flipped to the frozen pair), `server/test/jobs/favorites/engine.test.ts` (payload pin gains chapterPosition), `server/test/observability/metrics.integration.test.ts` (+1 instrumented module request: the first download create resolves the position through the info seam; the second hits the cache — count 2→3 with the reason commented). |
| `docs/USER-GUIDE.md` | The Output-defaults bullet: token vocabulary, `%NUMBERING%` semantics, the frozen default, the cbz default, the embedded ComicInfo. |

## Design decisions (all inside the D1 charter)

- **Numbering is positional, enqueue-frozen.** `<numbering>` = the
  chapter's 1-based ordinal in the site's chapter list, assigned when
  the job is created (scheduler diff position, batch index, or the
  single endpoint's info-seam lookup) and carried on the payload —
  exactly FMD2's shape (uSilentThread.pas:338 assigns
  `Format('%.4d', [i+1])` at task-build time). It is NEVER parsed
  from the chapter title (D1 §5 killed-ideas) and never re-derived at
  pack time (the live list may have grown; the enqueue-time ordinal is
  the stable one).
- **Idempotency note.** The queue fingerprint covers the payload the
  server actually enqueues, position included. Within the info-cache
  TTL the same body resolves the same position (replay stays a replay
  — pinned by test); a position shift between replays requires the
  site to have REORDERED its list mid-cache — an anomaly D1 §4.5
  already classifies as out-of-model, and the 409 explains itself.
- **ComicInfo Series = the effective folder, by construction.** The
  pack previously ran before the folder was known; the reorder makes
  the folder resolve first, so the metadata inside the archive and the
  path it lands at share one source of truth (D1 §3 "folder name =
  ComicInfo Series"). A saveTo override uses the target directory's
  basename as Series.
- **Fields: Series, Title, Web (manga URL), Notes (website label) —
  and nothing else.** `Web` is the ComicRack URL field Komga/Kavita
  render as the series link; `Notes` carries the source site label
  (the `%WEBSITE%` token's value). No Number/Volume: deliberately
  omitted because numbers parsed from titles are lossy (D1 §5) and
  the zero-padded filename prefix is the better parse target.
- **`.cbz` default.** `format` default flips `zip`→`cbz` — D1 §3
  "`.cbz` is the convention". Explicit user settings are untouched
  (only zod defaults + the seam-absent lane fallback changed); the
  FROZEN ruling applies to future default changes (migration event).
- **fmd-web writes ComicInfo and never reads it** (D1 §2): the only
  readers of ComicInfo.xml in the tree are TESTS asserting what the
  scanners will see.

## The grep-gate (no chapter-number parsing)

`scripts/no-chapter-number-parsing-gate.sh`, wired into `scripts/ci.sh`:

1. extractor-identifier idioms (`chapterNumber`,
   `parseChapterNumber`, …) must not exist in server/web src OR tests;
2. numeric coercion (`parseInt`/`parseFloat`/`Number(`) of a chapter
   Title/Name/Label variable in src — the classic title parse
   (FMD2-import's stored `CurrentChapter` INTEGER field is
   intentionally out of scope: a number already, never a title);
3. regex literals naming chapter AND carrying a digit class
   (the `/Chapter (\d+)/` shape) in src;
4. ANY regex application onto a chapterTitle/Name/Label variable
   (`.match(` / `.exec(`) in src — extracting anything from the label
   is the killed idea, not just digits.

Mutation-verified: each pattern was probed with a planted violation
(all four fire; the probe removed, the tree scans clean).

## Generated-fixture proof (the Komga/Kavita convention)

`server/test/jobs/library/komga-scan-target.test.ts` drives the REAL
ZipPacker('cbz') + REAL LibraryFinalizer over generated pages for
three series folders (clean title ×2 chapters, the
`[othermodule]` duplicate-title form, a second series) and then
sweeps the tree exactly the way a scanner does:

- every file is `<series>/<zero-padded-number> <label>.cbz`
  (`^\d{4} .+\.cbz$`), exactly two levels deep — folder-per-series
  grouping with the duplicate folded into its suffixed folder;
- zero dotfiles/`.tmp-` residue anywhere (recursive readdir);
- bytes complete at the final path (stat == packed size);
- ComicInfo.xml is the first entry, byte-exact against the builder,
  Series == the containing folder basename, Title == the label, NO
  Number/Volume, pages follow in reading order;
- atomic appearance drilled at EVERY finalize fault point: the final
  path is absent-or-complete never partial, residue is only sweepable
  `.tmp-` litter (the shipped stage→relocate→commit design, now
  pinned for the `.cbz` scan-target shape).

## Standing constraints (D1 §8) checklist

1. Gates via `/workspace/fmd-web/node_modules/.bin` directly — no npx
   anywhere in this story's runs.
2. Typed seams: `chapterPosition` is a zod-validated field on the
   public request schema AND the internal payload union; the OpenAPI
   snapshot + web client were REGENERATED in the same change
   (byte-equality test green); no `any`-shaped crossings.
3. Restart canon: not needed — no dev-preview restart in this story
   (server-only paths verified through the offline suites).
4. Long-form commit (this story's commit message).
5. No release tag.

## Coordination note (same-worktree)

The [fuzzy-javelin-pearls] search-scope lane committed 62dcd4e from
this shared worktree mid-flight. Per the b8de66f/99c5edd/26318fa
precedent the shared files (schemas/services/app/openapi/routes +
snapshot + web client) were reconstructed as HEAD(62dcd4e) + this
story's hunks only — verified by diff audit (no sibling content
reverted) — and the snapshot/web-client regen ran over the MERGED
surface (their preferred-sites/search-scope additions + this story)
in an isolated `/tmp/opencode` tree, never in the shared working
tree. The visual-fixture and dist-web drift the sibling flagged is
left to its owning lanes.

## Gates

- `node_modules/.bin/tsc -b server` — clean; `tsc -b web` — clean.
- `node_modules/.bin/eslint` on every touched file — clean.
- `bash scripts/no-chapter-number-parsing-gate.sh` — OK (and each of
  the four patterns mutation-verified to fire).
- Full offline suite: **245 files / 2394 passed | 3 skipped | 0
  failed** (366 s) — including the sibling's search-scope suites over
  the reconstructed shared files.
- `server/test/api/openapi.test.ts` — 6/6 (snapshot byte-equality over
  the merged surface).

## Review-bounce remediation (fail verdict by tidal-marsh-shines)

Two findings; both real. The remediation commit that follows 168787c
changes exactly TWO files — `scripts/no-chapter-number-parsing-gate.sh`
(1 line, the minor) and this addendum — and deliberately TOUCHES NO
APPLICATION CODE; why the blocker is repaired by verification and
disclosure rather than another edit is the point of this section.

### The blocker (services.ts:1481, staged hunk @@ -1465,6 +1472,13 @@)

168787c accidentally committed SEVEN LINES of the concurrently-active
[pipe-health] sibling lane's WIP — the `checkMissing` method on the
`FavoriteService` interface — inside this story's reconstructed
services.ts staging. The referenced type
`FavoriteMissingCheckResponseT` existed NOWHERE else in the committed
tree (its definition lives in the sibling's schemas.ts), so
**HEAD(168787c) did not compile**: the update-index reconstruction
had silently captured one sibling hunk too many, and the "full suite
on the exact staged content" claim in the commit message was
therefore false as stated for the committed tree.

**Reproduction (re-run for this record, isolated trees).** `git
archive 168787c` into a `/tmp/opencode` tree with its own
`node_modules` (cross-device symlink farm — `/workspace` and `/tmp`
are distinct mounts, hardlinks refuse EXDEV — with the four
`node_modules/@fmd/*` workspace links re-pointed at the ISOLATED
tree so `@fmd/server` resolves to the archived sources, §8.1 tool
paths): `tsc -b tsconfig.json --force` → **rc=2, 25 errors**, led by
the reviewer's exact citation
`server/src/api/services.ts(1481,37): error TS2552: Cannot find name
'FavoriteMissingCheckResponseT'`. All 25 are the leak's own cascade
(the missing type name; `TS2741 Property 'checkMissing' is missing
… required in type 'FavoriteService'` against
`InMemoryFavoriteService`/`SqliteFavoritesService`; the
assignability fallout in `main.ts`) — **zero errors touch this
story's own surface** (filenames/comic-info/packers/queue/settings).
The same isolation over HEAD(83b7f0d) → **rc=0, 0 errors**.

**Leak audit.** `git diff 62dcd4e 168787c` grepped for
pipe-health markers (`checkMissing|MissingCheck|hostPacing|HostPacer|
backoff|nextAttemptAt`) yields EXACTLY ONE foreign line — the
interface declaration (plus its 6-line doc comment, the staged hunk
@@ -1465,6 +1472,13 @@). No other sibling content rode along; the
story's own 17-file surface is otherwise exactly what the commit
message claims.

**Why the fix is not "remove the 7 lines" (the sequencing turn).**
This remediation was first drafted — before the bounce re-claim — as
a forward-removal commit: `168787c:services.ts` minus lines
1475–1481, staged by `hash-object`+`update-index`, with the leak
reverted to the sibling's uncommitted WIP. Before that commit could
land, the sibling lane landed **83b7f0d** (its SEQUENCING note
records the same accident from its side), which supplies the
implementations the leaked declaration was waiting for: the
`FavoriteMissingCheckResponseT` import, the in-memory
`checkMissing`, `SqliteFavoritesService.checkMissing`
(runtime/favorites-service.ts:136), and the route
`POST /api/favorites/:id/check-missing` whose handler calls
`services.favorites.checkMissing(id)` through the `FavoriteService`
type (app.ts:1540) — repairing `tsc -b` on a clean checkout of
master DELIBERATELY, with no history rewrite (coordinated with the
release lane, which already has v0.3.2 work based on this history).
Executing the drafted removal NOW would delete the interface method
that landed code compiles against — re-breaking the build this
story's own gate claims to keep green and gutting a landed sibling
feature — strictly worse than the accident it purports to cure. The
draft is therefore stood down; the disclosure above, the
reproduction, and the audit ARE this lane's remediation, plus the
green proof below that the exact content this lane now commits is
sound. The class-level lesson is already pinned by the repo's own
precedents (121ed33's discarded 4167172, 83b7f0d's repair note):
shared-worktree staging is explicit-pathspec-only, and a
reconstruction must be diffed against the sibling lanes' known-good
markers BEFORE commit, not grep-audited after.

**Gates on the exact staged tree.** The remediation was verified on
`git write-tree` of the staged index (hash recorded in the commit
message), archived into an isolated `/tmp/opencode` tree with the
same symlink-farm `node_modules` discipline as the reproduction
above — NOT on the WIP-contaminated shared worktree:

- `node_modules/.bin/tsc -b tsconfig.json` — rc=0 (identical sources
  to HEAD for every tsconfig scope; the delta is docs + one shell
  script line, outside all of them — the run proves it).
- Full offline suite — counts in the commit message; includes
  `server/test/api/openapi.test.ts` 6/6 (no API surface change: the
  OpenAPI snapshot is untouched).
- `bash scripts/ci.sh`-shaped gate invocation and the direct-exec
  A/B below.

Two verification-harness incidents during this run, disclosed:

- **The cross-device isolation artifact.** `/workspace` and `/tmp`
  are distinct mounts here, so the prior lanes' hardlinked
  `node_modules` isolation was impossible; a symlink-farm
  (`cp -rs`) copy was used instead — and made
  `server/test/engine/shims/corpus-live.test.ts` fail BOTH golden
  byte-stability tests on PURE HEAD as well (A/B: same single file
  green in the real worktree, red in the isolated tree). Root cause,
  byte-pinned by diffing a regenerated report against the committed
  golden: fontoxpath stack frames inside recorded `error` strings
  resolve to the symlink TARGET (`/workspace/fmd-web/node_modules/…`,
  absolute) instead of the root-relative `node_modules/…` the golden
  carries. Fix: `node_modules/fontoxpath` replaced with a REAL copy
  inside each isolated tree (660 KB; node_modules content, not tree
  content) — corpus-live then passes 4/4 on pure HEAD and the staged
  tree alike. No source, golden, or report byte differs between
  isolated and real trees.
- **One load-induced crash re-run.** The first full-suite attempt on
  the staged tree after the fontoxpath swap died in a vitest worker
  (V8 fatal → tinypool `ERR_IPC_CHANNEL_CLOSED`) with three isolated
  trees resident; after deleting the two diagnostic trees the
  canonical `vitest run` completed green (counts in the commit
  message). Same class as the SIGTERM-drain flake disclosed on
  168787c.

The remediation commit's tree equals HEAD(83b7f0d) plus exactly the
two files named above; `git diff-tree -r HEAD <commit> --` proves
the delta, and the post-commit shared index/worktree are byte-equal
to their pre-commit state for every sibling lane.

### The minor (scripts/no-chapter-number-parsing-gate.sh:1)

The shebang was `#!/usr/bin/bin bash` — a typo for
`#!/usr/bin/env bash`. Latent (ci.sh invokes the script as
`bash scripts/...`, so CI never tripped) but real: direct execution
of the committed 100755 script failed.

**Fix**: line 1 corrected to `#!/usr/bin/env bash`. A/B on the
isolated tree: the old-shebang copy execs with rc=127
(`cannot execute: required file not found` — the kernel hunting for
`/usr/bin/bin`); the fixed script runs **both** ways —
`./scripts/no-chapter-number-parsing-gate.sh` → rc=0 OK, and
`bash scripts/no-chapter-number-parsing-gate.sh` → rc=0 OK (the
ci.sh path unchanged). The four grep patterns are byte-identical to
the mutation-verified set from 168787c (1-line diff, pinned by
`git diff HEAD <commit> -- scripts/`).

### Remediation standing-constraints checklist (D1 §8)

1. All gates via `node_modules/.bin` in the isolated tree — no npx.
2. No API surface change in the remediation (docs + one script
   shebang); the OpenAPI snapshot is untouched and its byte-equality
   suite ran green in the full-suite pass above.
3. Restart canon: not needed — no dev-preview interaction; the
   verification is entirely offline-suite based.
4. Long-form commit (the remediation commit message).
5. No release tag.

