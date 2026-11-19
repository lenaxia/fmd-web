#!/usr/bin/env bash
# Chapter-number-parsing gate (D1 §5 killed-ideas + §7, the Komga/Kavita
# scan-target story): chapter numbers are NEVER parsed out of chapter
# titles/names — numbering is the 1-based LIST ORDINAL carried on the
# job payload (formatChapterNumbering, uSilentThread.pas:338 parity),
# and cross-site number alignment is a killed idea. This gate is the
# grep-shaped belt-and-braces behind that ruling: any code that starts
# extracting digits from chapter TITLES fails CI.
#
# Three idioms are forbidden in app code (server/src, web/src):
#   1. chapter-number extractor identifiers (chapterNumber,
#      parseChapterNumber, …) — the concept must not exist;
#   2. numeric coercion (parseInt/parseFloat/Number) applied to a
#      chapter Title/Name/Label variable — the classic title parse;
#   3. regex literals capturing digits from chapter-ish text
#      (`/Chapter (\d+)/` shapes) via exec/match/matchAll/test.
#
# DELIBERATELY ALLOWED (verified non-hits / scoped out):
#   - import/fmd2/parse.ts reads FMD2's stored CurrentChapter INTEGER
#     field (a number already, never a title) — pattern 2 only fires
#     on Title/Name/Label variables, so a `currentChapterRaw` coercion
#     is out of scope by design;
#   - formatChapterNumbering's padStart formats the POSITION the
#     payload carries (formatting, not parsing);
#   - engine Lua-module fixtures/corpus (module code is FMD2's own
#     ecosystem — semantics oracle, not ours to police).
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
err() { echo "no-chapter-number-parsing-gate: $1" >&2; fail=1; }

# (1) Extractor-identifier idioms (server + web, src AND tests — the
# concept must not exist anywhere in our code).
ident_hits=$(
  grep -rEn 'chapterNumber|chapterNum\b|parseChapterNumber|extractChapterNumber|getChapterNumber|numberFromChapter' \
    server/src web/src server/test web/test \
    --include='*.ts' --include='*.tsx' 2>/dev/null || true
)
if [[ -n "$ident_hits" ]]; then
  err "chapter-number extractor identifiers (numbering is the payload's list ordinal — D1 §7):
$ident_hits"
fi

# (2) Numeric coercion of chapter Title/Name/Label variables (src only
# — fixtures may carry numeric title STRINGS as data).
coerce_hits=$(
  grep -rEn '(parseInt|parseFloat|Number)\s*\(.*[Cc]hapter(Titles?|Names?|Labels?)' \
    server/src web/src \
    --include='*.ts' --include='*.tsx' 2>/dev/null || true
)
if [[ -n "$coerce_hits" ]]; then
  err "numeric coercion of chapter title/name/label (chapter numbers are NEVER parsed from titles — D1 §5):
$coerce_hits"
fi

# (3) Regex digit-capture against chapter text (src only): a regex
# literal (`/…/`) naming chapter AND carrying a digit class — the
# `/Chapter (\d+)/` title-extraction shape.
regex_hits=$(
  grep -rEn '/[^\n]*[Cc]hapter[^\n]*\\[dD][^\n]*/' \
    server/src web/src \
    --include='*.ts' --include='*.tsx' 2>/dev/null || true
)
if [[ -n "$regex_hits" ]]; then
  err "regex digit-capture on chapter text (read the payload's chapterPosition instead — D1 §7):
$regex_hits"
fi

# (4) ANY regex application onto a chapter title/name/label variable
# (src only): `.match/.matchAll` on chapterTitle/chapterName/... or
# `re.exec(chapterTitle)` — extracting from the label at all (chapter
# number, volume, whatever) is the killed idea, not just the digits
# spelling "chapter" inside the literal.
apply_hits=$(
  grep -rEn '(chapterTitles?|chapterNames?|chapterLabels?)\s*\.\s*(match|matchAll)\s*\(|\.exec\s*\(\s*(chapterTitles?|chapterNames?|chapterLabels?)' \
    server/src web/src \
    --include='*.ts' --include='*.tsx' 2>/dev/null || true
)
if [[ -n "$apply_hits" ]]; then
  err "regex applied to a chapter title/name/label (labels are data — identity is the link, numbering is the list ordinal; D1 §3/§5/§7):
$apply_hits"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "no-chapter-number-parsing-gate: FAILED" >&2
  exit 1
fi
echo "no-chapter-number-parsing-gate: OK (no chapter-number parsing in app code)"
