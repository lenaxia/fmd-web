# Evidence — [north-star] decision record (tsk-marble-deckhand-prosper)

Scope: commit the decision record the post-v0.3.2 batch derives from.
Docs-only story — no code, no fixtures, no snapshots changed.

## What landed

- `docs/DESIGN-NORTHSTAR.md` (new, 279 lines) — the record itself.
- `README.md` — Docs paragraph now links the north-star record first
  (product direction for the post-v0.3.2 batch).
- `docs/UX-PARITY.md` — header block links the record and states its
  rulings extend R1–R5. (Header region only; the M6-row edit in the
  same file belongs to the parallel [flat-layout] session's uncommitted
  work and is NOT in this commit — see Sequencing.)

## Charter coverage self-audit (all eight sections, verbatim-in-spirit)

| Charter section | Doc section |
|---|---|
| (1) Identity: Sonarr-for-manga, pipe with an inbox; UI exceptions/oversight only | §1 |
| (2) Five stages ENTER/PIPE/INBOX/TRIAGE/EXIT with every listed decision point | §2 (ENTER: paste-URL + search-with-scope + site browse, preferred-sites global allowlist, one-decision add · PIPE: existing scheduler, link-keyed diff, per-host pacing, single outbound webhook · INBOX: per-chapter seen, shared caught-up, 30d archive · TRIAGE: grouped by cause, paced retry-all, availability hint-never-gate · EXIT: flat `<manga>/`, `<manga> [<module>]` duplicate, `<numbering> <chapter>` names, ComicInfo metadata-only, Komga/Kavita scan-target contract) |
| (3) Invariants: identity (4) / safety (7) / pipeline (10) — all 21 bullets | §3, all present, none weakened |
| (4) Core assumptions (6) | §4 |
| (5) Killed-ideas ledger, 13 items, one-line reason each (disk monitoring DEFERRED) | §5 table |
| (6) Parity rule: semantics=oracle, mechanisms=strong prior, experience=ours | §6 |
| (7) Numbering decision + FMD2 template tokens | §7 (`%NUMBERING% %CHAPTER%` default fixed; tokens per uBaseUnit.pas:251-257; grounding uSilentThread.pas:338, uBaseUnit.pas:1823-1825) |
| (8) Standing constraints: .bin gates (npx broken), typed seams + OpenAPI regen, restart canon verbatim, long-form commit, no release tag, binds every story | §8 (plus README header sentence "apply to ALL stories" already standing) |

No new design invented: every mechanism named in the record either
ships today (realpath clamp, cover-proxy posture, engine-worker
topology, artifact-route boundary, conservative reconcile, digit
padding, `%CR%` seam) or is chartered by a backlog story in this epic
(webhook, inbox, search-scope, paste-URL, ComicInfo, pacing, triage).

## Gates

- Link check (script: extract every markdown link target from the three
  touched docs, resolve relative to each file, verify existence):
  `README.md` (251 lines), `docs/UX-PARITY.md` (190),
  `docs/DESIGN-NORTHSTAR.md` (279) — **ALL LINKS RESOLVE**, zero
  broken, zero http targets added.
- Full suite on the working tree (docs-only diff for this story):
  `node_modules/.bin/vitest run` — **236 files / 2322 passed | 3
  skipped | 0 failed** (336 s). No doc-build system exists in this
  repo (no mkdocs/typedoc/etc.), so link checks + suite are the doc
  gate, per the acceptance criteria.
- No server/web source touched by this story → tsc/eslint surfaces are
  unaffected by construction (suites above include the compiled-tree
  behavior).

## Sequencing / coordination

The worktree carries the parallel [flat-layout] story's UNCOMMITTED
changes (library layout code + DESIGN.md/USER-GUIDE/UX-PARITY M6-row
edits) — same-worktree coordination as in the b8de66f/99c5edd
precedent. This commit stages ONLY this story's files/hunks:
`docs/DESIGN-NORTHSTAR.md` (new), `README.md` (whole file — untouched
by the sibling), the evidence file, and the UX-PARITY **header hunk
only** (staged via a filtered patch; the M6-row hunk remains unstaged
for the sibling's commit). The doc records the flat layout as the
decision (§2 EXIT) consistent with their in-flight implementation.
