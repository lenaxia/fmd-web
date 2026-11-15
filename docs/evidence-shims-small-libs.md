
## Final verification round (post-move integrity sweep, 12:35)

- The gzip binary-roundtrip vector had a real test-side bug (the JS-side
  deflate producer returns base64; the chunk passed it straight to
  Inflate, which base64-encodes its input — inflate-of-base64-of-base64
  → nil → the assert's `__fmd_b64enc(out)` raised). Fixed: the chunk
  decodes the producer's return (`__fmd_b64dec(__test_raw_deflate_b64(
  __fmd_b64enc(data)))`) — 0..255 byte-exact roundtrip genuinely proven.
- Story suites re-run: gzip + pcre2 + logger + require-registry —
  **71/71 green**.
- `tsc -b` currently reports exactly 2 errors, both in files under
  CONCURRENT edit by another story (bypass-adapter.test.ts 11:24,
  antibot.pipeline.integration.test.ts 12:12 — a multi-value
  RunCommandHide return + an exactOptionalPropertyTypes slip). Zero
  errors in story-owned files.
- COMPAT.md tracker rows re-verified `implemented` on disk (the file was
  regenerated again by a concurrent actor — row text differs, status
  and the curated gzip/pcre2/logger notes sections persist).

## Review bounce resolution (fail → re-verify, fresh claim 5f74ffec)

**Blocker (criterion 1) — the fmd.pcre2 expressibility ledger did not
exist in COMPAT.md.** Root cause: the three curated notes sections
(gzip/pcre2/logger) I appended after the first move were consumed by a
CONCURRENT COMPAT.md regeneration from a stale tree — the generator
preserves everything from the `## fmd.crypto compatibility notes` marker
to EOF (generate-compat.ts:338-342), so sections appended BELOW the
marker do survive; the concurrent write simply started from a tree
without them. Fix: re-appended `## fmd.gzip compatibility notes`,
`## fmd.pcre2 compatibility notes` and `## fmd.logger compatibility
notes` below the crypto-notes marker. Persistence proof: ran
`npx tsx corpus/scripts/generate-compat.ts` TWICE — both runs
byte-stable (`diff` empty between runs), all three sections + the
crypto/HTTP notes survive; corpus replay 912/912 = 100.00%. The
regenerated tracker rows reference the notes ("expressibility ledger in
the fmd.pcre2 compatibility notes below") and the ledger enumerates:
backend choice (V8 RegExp; RE2-native/pcre2-wasm not vendorable
offline), the exact translation layer, possessive/atomic downgrades,
the full loud-fail set (\K \C \X \G, recursion/subroutines,
conditionals, callouts, branch reset, (?x)/(?U)/(?u), flag negation,
scoped (?flags:), non-LF (*verbs), \R-in-class), substitution-string
edges ($-out-of-range / unknown ${name} stay literal), ^-at-startoffset
(NOTBOL), gmatch zero-width loop-forever, and the byte-level-subjects
non-goal — each with the 0/418-module / 0-seed D11 cost.

**Minor (criterion 3) — the evidence file's persistence claim was
false for the current tree.** Corrected by this section: the final
verified state is the one above (re-appended + double-regeneration
byte-stability proof), replacing the earlier "sections persist" claim
that a concurrent regeneration had invalidated.

**Gates re-run after the fix:** story suites (gzip/pcre2/logger/
require-registry) green; `npm run contract:check` → 0 mismatches.
