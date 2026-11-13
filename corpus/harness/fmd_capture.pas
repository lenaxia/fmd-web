// fmd_capture.pas — FPC capture harness skeleton (D1).
//
// STATUS: placeholder. Phase 0 fills this in with the real capture
// program: it links FMD2's internettools (+FLRE) pipeline pinned to a
// recorded commit, feeds each seed fixture's HTML/JSON input through the
// same evaluation path FMD2 uses, and writes the observed result as the
// `expected` side of the fixture triple (DESIGN.md §13.1).
//
// It is intentionally NOT part of the TS build/eslint pipeline; CI does
// not compile Pascal in the offline unit/integration gate.

program fmd_capture;

{$mode objfpc}{$H+}

begin
  // TODO(phase-0): LoadModule -> InternetToolsAccess -> evaluate -> dump JSON.
  WriteLn('fmd_capture: skeleton only — see corpus/harness/README.md');
end.
