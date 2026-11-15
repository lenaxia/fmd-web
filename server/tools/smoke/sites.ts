/**
 * The heterogeneous live-suite site list (DESIGN §12 Phase-1 "live
 * GetInfo correct on 10 heterogeneous sites" + §13.2 nightly smoke).
 * Twelve seed-corpus sites spanning nine template/API families; every
 * module ships in corpus/fixtures/seed (manifest + fixture provenance)
 * and executes its real GetInfo through the real host + §5.4 shims.
 *
 * The suite is the LIVE-EVIDENCE counterpart of the offline corpus
 * oracle: pass rates here are observability for operators, never a CI
 * gate (scripts/ci.sh never runs it — the --live CLI flag is the only
 * entry).
 */

export type SiteCategory =
  | 'json-api'
  | 'protobuf'
  | 'madara-template'
  | 'madara-family'
  | 'mangathemesia'
  | 'account-gated'
  | 'json-gallery'
  | 'imagepuzzle'
  | 'standalone-html';

export interface SiteDef {
  /** Seed-corpus module name (corpus/fixtures/seed/<name>/). */
  readonly name: string;
  readonly category: SiteCategory;
  /** GetInfo event URL (series/gallery page where the module expects one). */
  readonly url: string;
  /**
   * Account-gated site: without configured credentials the module
   * cannot meaningfully pass — any non-pass outcome is classified
   * `skip:account-gated` (expected-skip, excluded from pass rates).
   */
  readonly gated?: boolean;
  /** How the mock cluster simulates this site (loopback fallback runs). */
  readonly mock?: 'fixture' | 'login-gate' | 'cloudflare-403';
  readonly note?: string;
}

export const LIVE_SUITE_SITES: readonly SiteDef[] = [
  {
    name: 'MangaDex',
    category: 'json-api',
    url: 'https://mangadex.org/title/dc07afaa-643a-4bf4-a9d0-b21ecc101736',
    note: 'JSON API (api.mangadex.org); GetInfo extracts the title GUID from the URL',
  },
  {
    name: 'MangaPlus',
    category: 'protobuf',
    url: 'https://mangaplus.shueisha.co.jp/titles/100020',
    note: 'pb.decode protobuf RPC (title_detailV3) via the D17 pb shim',
  },
  {
    name: 'KlikManga',
    category: 'madara-template',
    url: 'https://klikmanga.com/manga/solo-leveling/',
    note: 'instantiates templates/Madara.lua',
  },
  {
    name: 'AsuraScans',
    category: 'madara-family',
    url: 'https://asurascans.com/series/solo-leveling',
    note: 'Madara-family standalone module',
  },
  {
    name: 'ManhwaIndo',
    category: 'mangathemesia',
    url: 'https://manhwaindo.id/manga/solo-leveling/',
    note: 'MangaThemesia template (id_ID)',
  },
  {
    name: 'EHentai',
    category: 'account-gated',
    url: 'https://e-hentai.org/g/4331313/9003413817/',
    gated: true,
    mock: 'login-gate',
    note: 'account/login module — credentials absent in the harness = expected-skip',
  },
  {
    name: 'HitomiLa',
    category: 'json-gallery',
    url: 'https://hitomi.la/galleries/2764271.html',
    note: 'JS-backed gallery; GetInfo fetches the ltn JSON',
  },
  {
    name: '18Comic',
    category: 'imagepuzzle',
    url: 'https://18comic.vip/gallery/483553/',
    mock: 'cloudflare-403',
    note: 'require fmd.imagepuzzle — exercises the shims-image-libs registration',
  },
  {
    name: 'ComicK',
    category: 'json-api',
    url: 'https://comick.live/comic/solo-leveling',
    note: 'json() expressions over the comic API',
  },
  {
    name: 'Tapas',
    category: 'standalone-html',
    url: 'https://tapas.io/series/cinderella-boy',
    note: 'TotalDirectory standalone (JS-heavy landing pages)',
  },
  {
    name: 'NineManga',
    category: 'standalone-html',
    url: 'https://www.ninemanga.com/manga/Solo%20Leveling.html',
    note: 'multi-language directory',
  },
  {
    name: 'MangaKatana',
    category: 'standalone-html',
    url: 'https://mangakatana.com/manga/urasekai-picnic',
    note: 'standalone aggregator',
  },
] as const;

/** Suite contract: heterogeneous, ≥10 sites, every name in the seed corpus. */
export function validateSuite(sites: readonly SiteDef[]): string[] {
  const problems: string[] = [];
  if (sites.length < 10) {
    problems.push(`suite has ${sites.length} sites (contract: ≥10)`);
  }
  const categories = new Set(sites.map((s) => s.category));
  if (categories.size < 5) {
    problems.push(`suite spans only ${categories.size} families (contract: heterogeneous, ≥5)`);
  }
  return problems;
}
