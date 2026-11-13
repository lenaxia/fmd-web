# Fixtures

Ground-truth triples replayed **offline** in CI (DESIGN.md §13.1).

- `seed/` — Phase-0 seed set. Files must validate against the runner
  loader (`corpus/runner/fixture-loader.ts`).
- `captured: true` triples were recorded from FMD2 by the FPC harness
  (`../harness/`); `synthetic: true` triples are authored from
  DESIGN.md semantics and must be replaced by real captures before the
  Phase-1 exit criterion (§12).
- Fixture batches record the pinned `internettoolsCommit` in `meta`
  (dialect behavior varies by version — §13.1).

Required coverage for the seed set: plain XPath, `json(...)` node-tree
forms (both `.prop` and `?prop` styles), list-fill overloads, `css()`,
error-swallowing cases, and GetInfo normalization pipelines
(raw module output → post-processed result, §5.8).
