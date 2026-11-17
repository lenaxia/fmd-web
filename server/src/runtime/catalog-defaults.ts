/**
 * Curated default bootstrap catalogs (launch defect (c)): the four
 * FMD2 dist-config default IDs are unfit as defaults (observed dead
 * upstream during the launch attempt — FMD2-DB periodically purges
 * retired sites), so the D20 bootstrap ships a curated, VERIFIED-LIVE
 * set instead: every ID below is cross-referenced against BOTH the
 * pinned FMD2 tree (each registers as a module — checked in
 * server/test/sync/modules/staged-tolerance + the sweep golden) AND the
 * live FMD2-DB 7z listing (HEAD 200 — the network-gated
 * server/test/live/defaults-live.test.ts re-verifies on demand, so rot
 * is caught by CI, not discovered by users).
 *
 * Lives in SERVER CONFIG, not env: FMD_BOOTSTRAP_CATALOGS (csv) still
 * overrides it entirely for compose/e2e/dev.
 */
export const DEFAULT_BOOTSTRAP_CATALOGS: readonly string[] = [
  // KLManga
  '010777f53bf2414fad039b9567c8a9ce',
  // InManga
  '03ae42ac9141443fa0711bd401c0203d',
  // MangaPark (mangapark.me variant — the tree registers 13 park domains under distinct IDs)
  '09d49c7760904bc2817dbc80757de44a',
  // Hentai2Read
  '053da85062184626a0a1ff6d57c3c955',
];
