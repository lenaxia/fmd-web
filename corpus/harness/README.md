# FPC capture harness (D1)

Captures ground-truth triples from **FMD2 itself** (desktop capture as
cross-check, DESIGN.md §13.1 / §14 D1). The corpus replays **offline in
CI** against these recorded fixtures — results must *equal* FMD2's output
(pass-without-error is necessary-not-sufficient).

## Build discipline

- The harness links **internettools + FLRE pinned externally**; the exact
  `internettools` commit is recorded per fixture batch in `meta.internettoolsCommit`
  (dialect behavior varies by version — §13.1).
- We replicate the pure string helpers rather than linking
  `uBaseUnit.pas`, which pulls LCL units.

## Triple format (fixtures/*.json)

```json
{
  "id": "seed/getinfo-normalization-0001",
  "moduleId": "<32-hex FMD2 module ID>",
  "kind": "getinfo-normalization",
  "input": { "...raw module output..." },
  "expected": { "...post-processed result (§5.8 pipeline)..." },
  "meta": { "captured": true, "synthetic": false, "internettoolsCommit": "<sha>" }
}
```

`captured: true` = recorded from FMD2 via this harness. `synthetic: true`
= authored from DESIGN.md semantics (used until a real capture exists;
must be replaced by captured triples before Phase-1 exit).

## Phase-0 seed coverage target (§12)

≥50 seed modules including: JSON-API sites, MangaPlus (protobuf/`pb`),
Madara template, Duktape, imagepuzzle, bypass, account modules (EHentai
et al.), and fill-list page collectors.
