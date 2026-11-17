/**
 * Filename composition (DESIGN §7.1 "Filenames"; FMD2
 * `TTaskThread.GetFileName`, uDownloadsManager.pas:530-550): the
 * module FileNames[] entry (when FileNames.Count = PageLinks.Count),
 * the `%.3d` index fallback, the `%FILENAME%` custom-rename template
 * (`DEFAULT_FILENAME_CUSTOMRENAME`, FMDOptions.pas:26 — an empty
 * CustomFileName defaults to it, :1112-1114), then the SHARED D5 final
 * step (`applyFileNamePolicy` from `@fmd/contract`, DESIGN.md §14 D5):
 * Windows-desktop parity tail-truncation when
 * `CurrentMaxFileNameLength > 0` (Delete from the HEAD — the TAIL
 * survives; 0 = no limit) by default, or the `FMD_NORMALIZE_PATHS=1` /
 * `--normalize-paths` Linux-normalized opt-out (control units deleted,
 * NO tail truncation) when switched on. The mode logic lives only in
 * the contract policy — never duplicated here.
 */

import { applyFileNamePolicy, type FileNamePolicyMode } from '@fmd/contract';

/** The custom-rename placeholder (CR_FILENAME, uBaseUnit.pas:257). */
export const FILENAME_PLACEHOLDER = '%FILENAME%';

/** `Format('%.3d', [WorkId + 1])` fallback (:538-539). */
/**
 * WorkId → the zero-padded page number ([parity-sweep] M6/M8: FMD2's
 * chapter-numbering digits, lfm:4026 — `padding` sets a MINIMUM width,
 * 0 keeps the server default 3; the width still grows with the page
 * count so ordering is stable).
 */
export function indexFileName(workId: number, padding: number = 0): string {
  const width: number = padding >= 1 ? Math.trunc(padding) : 3;
  return String(workId + 1).padStart(width, '0');
}

export function composeFileName(
  workId: number,
  fileNames: readonly string[],
  pageCount: number,
  template: string,
  maxLength: number,
  mode?: FileNamePolicyMode | undefined,
): string {
  // :531-533 — the module filename only when the lists align
  let candidate = '';
  if (fileNames.length === pageCount && workId < fileNames.length) {
    candidate = fileNames[workId] ?? '';
  }
  if (candidate === '') {
    candidate = indexFileName(workId);
  }
  // :1112-1114 — empty CustomFileName defaults to '%FILENAME%'
  const effectiveTemplate = template === '' ? FILENAME_PLACEHOLDER : template;
  // :542 — StringReplace(CurrentCustomFileName, CR_FILENAME, Result, rfReplaceAll)
  const result = effectiveTemplate.split(FILENAME_PLACEHOLDER).join(candidate);
  // :543-550 via the shared D5 choke point — parity tail truncation by
  // default; the Linux-normalized opt-out never truncates.
  return applyFileNamePolicy(result, { maxLength, mode });
}
