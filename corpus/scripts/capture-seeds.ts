/**
 * Seed fixture capture (DESIGN.md §13.1) — records the offline corpus
 * for ≥50 seed modules.
 *
 * For each seed: fetch ONE live page/response with curl, store the body
 * under corpus/fixtures/seed/<Module>/, write a manifest.json, harvest
 * the module's static TXQuery expressions, run them through the FPC
 * oracle (corpus/harness/bin/fmd_capture — the exact engine FMD2 uses)
 * and store the resulting triples.json. After capture, everything is
 * replayable fully offline.
 *
 * Usage:  npx tsx corpus/scripts/capture-seeds.ts [--only Name,...]
 *
 * Template fixtures (e.g. Madara) have no real m.ID; their manifest
 * moduleId is md5("fmd-template:<name>") and flagged syntheticId: true.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harvestLuaSource } from '../harvester/harvest.js';
import type { QueryLanguage } from '@fmd/contract';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FMD2_LUA = process.env['FMD2_LUA_DIR'] ?? '/workspace/FMD2/lua';
const SEED_DIR = join(ROOT, 'fixtures/seed');
const CAPTURE_BIN = join(ROOT, 'harness/bin/fmd_capture');
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

interface SeedSpec {
  readonly module: string;
  readonly dir: 'modules' | 'templates';
  /** URL to capture once. */
  readonly url: string;
  readonly kind: 'html' | 'json' | 'xml' | 'protobuf' | 'text';
  readonly description: string;
  /** Template family tag for the manifest. */
  readonly template?: string;
  /**
   * Fetch path. 'direct' (default): plain curl — may be refused by
   * TLS-fingerprinting CDNs; a refusal automatically retries through
   * the jina reader (server-side fetch, raw HTML via X-Return-Format).
   * 'wayback': fetch the given web.archive.org raw snapshot (for sites
   * that are hard-blocked everywhere — provenance recorded).
   */
  readonly via?: 'direct' | 'jina' | 'wayback';
}

/** Curated seed table: the 10 named special cases first. */
const NAMED_SEEDS: SeedSpec[] = [
  {
    module: 'ComicK',
    dir: 'modules',
    url: 'https://comick.cc/api/search?order_by=user_follow_count&order_direction=desc&type=comic',
    kind: 'json',
    description: 'JSON API directory (search endpoint, json() expressions; RootURL domain comick.live rotates to comick.cc)',
  },
  {
    module: 'MangaPlus',
    dir: 'modules',
    url: 'https://jumpg-webapi.tokyo-cdn.com/api/title_list/allV2',
    kind: 'protobuf',
    description: 'pb.decode Response payload — provenance for the pb shim',
  },
  {
    module: 'Madara',
    dir: 'templates',
    url: 'https://wuxiaworld.site/manga/?page=1',
    kind: 'html',
    description: 'Madara template directory page captured on a live Madara site (Duktape JS require flow)',
    template: 'Madara',
  },
  {
    module: 'EHentai',
    dir: 'modules',
    url: 'https://e-hentai.org/',
    kind: 'html',
    description: 'Account/login module — public gallery list page',
  },
  {
    module: 'Tapas',
    dir: 'modules',
    url: 'https://tapas.io/comics',
    kind: 'html',
    description: 'TotalDirectory — comics landing page (GetDirectoryPageNumber expressions run here)',
  },
  {
    module: 'Hentai2Read',
    dir: 'modules',
    url: 'https://hentai2read.com/browse/newest/page-1/',
    kind: 'html',
    description: 'XPathStringAll list-fill + json() inside expressions',
    via: 'jina',
  },
  {
    module: 'MangaDex',
    dir: 'modules',
    url: 'https://api.mangadex.org/manga?limit=8&hasAvailableChapters=true',
    kind: 'json',
    description: 'JSON API (io cache module) — manga list response',
  },
  {
    module: '18Comic',
    dir: 'modules',
    url: 'http://web.archive.org/web/20220218093959id_/https://18comic.vip/albums?o=mr&page=1',
    kind: 'html',
    description: 'imagepuzzle module — album directory grid (live site hard-blocked; captured from the web.archive.org raw snapshot, 2022-02-18)',
    via: 'wayback',
  },
  {
    module: 'MangaGo',
    dir: 'modules',
    url: 'https://www.mangago.me/genre/all/1/?sortby=create_date',
    kind: 'html',
    description: 'Duktape-based module — genre directory page',
    via: 'jina',
  },
  {
    module: 'AsuraScans',
    dir: 'modules',
    url: 'https://asurascans.com/',
    kind: 'html',
    description: 'Madara-family standalone — homepage list',
  },
];

/** Diverse fill-ins: template families, languages, API vs HTML. */
const FILLER_SEEDS: SeedSpec[] = [
  { module: 'MangaThemesia', dir: 'templates', url: 'https://mangakita.net/manga/?page=1', kind: 'html', description: 'MangaThemesia template directory page', template: 'MangaThemesia' },
  { module: '3asq', dir: 'modules', url: '', kind: 'html', description: 'Madara-based (Arabic)' },
  { module: 'ApollComics', dir: 'modules', url: '', kind: 'html', description: 'Madara-based' },
  { module: 'BrainRotComics', dir: 'modules', url: '', kind: 'html', description: 'Madara-based' },
  { module: 'EmperorScan', dir: 'modules', url: '', kind: 'html', description: 'Madara-based (Spanish)' },
  { module: 'KissMangaIN', dir: 'modules', url: '', kind: 'html', description: 'Madara-based' },
  { module: 'KlikManga', dir: 'modules', url: '', kind: 'html', description: 'Madara-based (id_ID)' },
  { module: 'KomikUp', dir: 'modules', url: '', kind: 'html', description: 'Madara-based (id_ID)' },
  { module: 'LHTranslation', dir: 'modules', url: '', kind: 'html', description: 'Madara-based' },
  { module: 'LectorManga', dir: 'modules', url: '', kind: 'html', description: 'Madara-based (Spanish)' },
  { module: 'LeerManga', dir: 'modules', url: '', kind: 'html', description: 'Madara-based (Spanish)' },
  { module: 'LilyManga', dir: 'modules', url: '', kind: 'html', description: 'Madara-based' },
  { module: 'GourmetScans', dir: 'modules', url: '', kind: 'html', description: 'Madara-based (French)' },
  { module: 'HadesScans', dir: 'modules', url: '', kind: 'html', description: 'Madara-based' },
  { module: 'DoujinHentai', dir: 'modules', url: '', kind: 'html', description: 'Madara-based gallery' },
  { module: 'CartoonPorn', dir: 'modules', url: '', kind: 'html', description: 'Madara-based gallery' },
  { module: 'Hentai20', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based' },
  { module: 'MangaSusu', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (id_ID)' },
  { module: 'Doujinku', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (id_ID)' },
  { module: 'BacaKomik', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (id_ID)' },
  { module: 'KomikStation', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (id_ID)' },
  { module: 'Komiktap', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (id_ID)' },
  { module: 'ManhwaIndo', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (id_ID)' },
  { module: 'ARESManga', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (Spanish)' },
  { module: 'AdonisFansub', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (Spanish)' },
  { module: 'MadaraScans', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (Spanish)' },
  { module: 'Mangacan', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (id_ID)' },
  { module: '9hentai', dir: 'modules', url: '', kind: 'json', description: 'Gallery with JSON API' },
  { module: 'AsmHentai', dir: 'modules', url: '', kind: 'html', description: 'Gallery source' },
  { module: 'HentaiEra', dir: 'modules', url: '', kind: 'html', description: 'Gallery source' },
  { module: 'HentaiHere', dir: 'modules', url: '', kind: 'html', description: 'Standalone' },
  { module: 'HentaiLib', dir: 'modules', url: '', kind: 'html', description: 'LibGroup-based' },
  { module: 'HentaiNexus', dir: 'modules', url: '', kind: 'html', description: 'Gallery source' },
  { module: 'LxHentai', dir: 'modules', url: '', kind: 'html', description: 'Vietnamese source' },
  { module: 'EgoToons', dir: 'modules', url: '', kind: 'html', description: 'Spanish toon source' },
  { module: 'LunaToons', dir: 'modules', url: '', kind: 'html', description: 'Toon source' },
  { module: 'GenzToons', dir: 'modules', url: '', kind: 'html', description: 'Toon source' },
  { module: 'LectorHentai', dir: 'modules', url: '', kind: 'html', description: 'Gallery source (Spanish)' },
  { module: 'VerMangasPorno', dir: 'modules', url: '', kind: 'html', description: 'Gallery source (Spanish)' },
  { module: 'MangaKatana', dir: 'modules', url: '', kind: 'html', description: 'Standalone aggregator' },
  { module: 'MangaNato', dir: 'modules', url: '', kind: 'html', description: 'Aggregator' },
  { module: 'NicoManga', dir: 'modules', url: '', kind: 'html', description: 'Japanese source' },
  { module: 'Rawkuma', dir: 'modules', url: '', kind: 'html', description: 'Japanese raw source' },
  { module: 'RawDEX', dir: 'modules', url: '', kind: 'html', description: 'Japanese raw source' },
  { module: 'Raw1001', dir: 'modules', url: '', kind: 'html', description: 'Japanese raw source' },
  { module: 'RawSenManga', dir: 'modules', url: '', kind: 'html', description: 'Japanese raw source' },
  { module: 'TuMangaNet', dir: 'modules', url: '', kind: 'html', description: 'Spanish source' },
  { module: 'TuMangaOnline', dir: 'modules', url: '', kind: 'html', description: 'Spanish aggregator' },
  { module: 'WebtoonXYZ', dir: 'modules', url: '', kind: 'html', description: 'Webtoon source' },
  { module: 'MangaKakalotFun', dir: 'modules', url: '', kind: 'html', description: 'Aggregator' },
  { module: 'MangaTV', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based' },
  { module: 'Kanzenin', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (id_ID)' },
  { module: 'CerberusSeries', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (Spanish)' },
]

/** Substitute pool if fillers fail. */
const SUBSTITUTES: SeedSpec[] = [
  { module: 'ElfToon', dir: 'modules', url: '', kind: 'html', description: 'Toon source' },
  { module: 'BeeHentai', dir: 'modules', url: '', kind: 'html', description: 'Gallery source' },
  { module: 'HentaiForce', dir: 'modules', url: '', kind: 'html', description: 'Gallery source' },
  { module: 'HentaiRead', dir: 'modules', url: '', kind: 'html', description: 'Gallery source' },
  { module: 'HentaiSlayer', dir: 'modules', url: '', kind: 'html', description: 'Gallery source' },
  { module: 'Hentaidexy', dir: 'modules', url: '', kind: 'html', description: 'Gallery source' },
  { module: 'BoratScans', dir: 'modules', url: '', kind: 'html', description: 'Madara-based' },
  { module: 'Luvyaa', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based' },
  { module: 'LeeMiau', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based' },
  { module: 'DatgarScanlation', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (Spanish)' },
  { module: 'ManhwaLand', dir: 'modules', url: '', kind: 'html', description: 'MangaThemesia-based (id_ID)' },
  { module: 'LerHentais', dir: 'modules', url: '', kind: 'html', description: 'Gallery source (Spanish)' },
  { module: 'RawDevart', dir: 'modules', url: '', kind: 'html', description: 'Japanese raw source' },
  { module: 'RawINU', dir: 'modules', url: '', kind: 'html', description: 'Japanese raw source' },
  { module: '11Toon', dir: 'modules', url: '', kind: 'html', description: 'Toon source' },
]

function luaPath(spec: SeedSpec): string {
  return join(FMD2_LUA, spec.dir, `${spec.module}.lua`);
}

interface ModuleFacts {
  readonly id: string;
  readonly rootURL: string;
  readonly syntheticId: boolean;
}

function moduleFacts(spec: SeedSpec): ModuleFacts {
  const source = readFileSync(luaPath(spec), 'utf8');
  const idMatch = /m\.ID\s*=\s*'([0-9a-f]{32})'/.exec(source);
  const rootMatch = /m\.RootURL\s*=\s*'([^']+)'/ .exec(source);
  if (idMatch !== null && rootMatch !== null) {
    return { id: idMatch[1] as string, rootURL: rootMatch[1] as string, syntheticId: false };
  }
  // Templates (e.g. Madara.lua) have no m.ID — deterministic synthetic id.
  const id = createHash('md5').update(`fmd-template:${spec.module}`).digest('hex');
  return {
    id,
    rootURL: rootMatch?.[1] ?? '',
    syntheticId: true,
  };
}

function curlOnce(args: string[], outFile: string, timeoutMs = 45_000): boolean {
  // -o/-w must precede the positional args (which end with the URL).
  const res = spawnSync(
    'curl',
    ['-o', outFile, '-w', '%{http_code}', ...args],
    { encoding: 'utf8', timeout: timeoutMs },
  );
  const code = (res.stdout as unknown as string).trim();
  if (res.status !== 0 || code !== '200') return false;
  const size = execFileSync('stat', ['-c', '%s', outFile], { encoding: 'utf8' });
  return Number(size) > 200;
}

function fetchOnce(
  url: string,
  outFile: string,
  kind: string,
  via: SeedSpec['via'],
): boolean {
  if (via !== 'wayback') {
    const direct = curlOnce(
      ['-sSL', '--max-time', '30', '--compressed', '-A', UA,
       '-H', 'Accept: text/html,application/json,application/xml,*/*',
       '--', url],
      outFile,
    );
    if (direct || via === 'direct' || kind !== 'html') return direct;
    // TLS-fingerprinting CDN refused plain curl — retry through the
    // jina reader (server-side fetch; X-Return-Format: html = raw HTML).
    execFileSync('sleep', ['1']);
    return curlOnce(
      ['-sSL', '--max-time', '90', '-H', 'X-Return-Format: html',
       '--', `https://r.jina.ai/${url}`],
      outFile,
      120_000,
    );
  }
  return curlOnce(
    ['-sSL', '--max-time', '60', '--compressed',
     '--', url],
    outFile,
    90_000,
  );
}

/** Oracle engine value for a harvested language. */
function oracleEngine(language: QueryLanguage): 'xpath' | 'css' {
  return language === 'css' ? 'css' : 'xpath';
}

const MAX_EXPRESSIONS_PER_MODULE = 30;

interface HarvestedLite {
  readonly id: string;
  readonly expression: string;
  readonly language: QueryLanguage;
  readonly output: string;
}

function pickExpressions(source: string, kind: string): HarvestedLite[] {
  const all = harvestLuaSource(source).filter((e) => !e.dynamic);
  const wantedFirst = kind === 'json' ? ['json', 'xpath', 'css', 'xquery'] : ['xpath', 'css', 'json', 'xquery'];
  const byLang = new Map<QueryLanguage, typeof all>();
  for (const lang of wantedFirst) {
    byLang.set(
      lang as QueryLanguage,
      all.filter((e) => e.language === lang),
    );
  }
  const picked: HarvestedLite[] = [];
  // Round-robin languages so the fixture covers the dialect mix.
  for (let round = 0; picked.length < MAX_EXPRESSIONS_PER_MODULE; round++) {
    let added = false;
    for (const lang of wantedFirst) {
      const list = byLang.get(lang as QueryLanguage) ?? [];
      const item = list[round];
      if (item !== undefined) {
        picked.push({
          id: item.id,
          expression: item.expression,
          language: item.language,
          output: item.output,
        });
        added = true;
        if (picked.length >= MAX_EXPRESSIONS_PER_MODULE) break;
      }
    }
    if (!added) break;
  }
  return picked;
}

interface SeedOutcome {
  readonly module: string;
  readonly ok: boolean;
  readonly reason?: string;
}

function captureSeed(spec: SeedSpec): SeedOutcome {
  const outDir = join(SEED_DIR, spec.module);
  let facts: ModuleFacts;
  try {
    facts = moduleFacts(spec);
  } catch (e) {
    return { module: spec.module, ok: false, reason: `no lua file: ${String(e)}` };
  }
  const url = spec.url === '' ? `${facts.rootURL.replace(/\/$/, '')}/` : spec.url;
  if (facts.rootURL === '' && spec.url === '') {
    return { module: spec.module, ok: false, reason: 'no RootURL in lua' };
  }
  const ext =
    spec.kind === 'json' ? 'json' : spec.kind === 'html' ? 'html' : 'bin';
  const bodyFile = join(outDir, `source.${ext}`);
  const manifestPath = join(outDir, 'manifest.json');

  if (existsSync(manifestPath) && existsSync(bodyFile) && existsSync(join(outDir, 'triples.json'))) {
    return { module: spec.module, ok: true, reason: 'already captured' };
  }

  mkdirSync(outDir, { recursive: true });
  const fetched = fetchOnce(url, bodyFile, spec.kind, spec.via);
  if (!fetched) {
    rmSync(outDir, { recursive: true, force: true });
    return { module: spec.module, ok: false, reason: `fetch failed: ${url}` };
  }

  const source = readFileSync(luaPath(spec), 'utf8');
  let expressions = pickExpressions(source, spec.kind);
  let templateUsed: string | undefined = spec.template;
  let expressionSource = spec.dir;
  if (expressions.length === 0) {
    // Stub module: its query surface lives in a required template
    // (e.g. `local Template = require 'templates.Madara'`).
    const req = /require\s*['"]templates\.([A-Za-z]+)['"]/.exec(source);
    if (req !== null) {
      const tplPath = join(FMD2_LUA, 'templates', `${req[1]}.lua`);
      try {
        expressions = pickExpressions(readFileSync(tplPath, 'utf8'), spec.kind);
        templateUsed = req[1];
        expressionSource = 'templates';
      } catch {
        // keep empty
      }
    }
  }

  const manifest = {
    moduleId: facts.id,
    module: spec.module,
    capturedAt: new Date().toISOString().slice(0, 10),
    ...(templateUsed !== undefined ? { template: templateUsed } : {}),
    expressionSource,
    ...(facts.syntheticId ? { syntheticId: true } : {}),
    entries: [
      {
        fixtureId: `seed/${spec.module}/source`,
        file: `source.${ext}`,
        kind: spec.kind,
        url,
        description: spec.description,
      },
    ],
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  if (expressions.length === 0) {
    // Special-case module without static expressions (e.g. MangaPlus pb):
    // manifest-only fixture is valid provenance.
    writeFileSync(
      join(outDir, 'triples.json'),
      JSON.stringify(
        {
          generator: 'fmd_capture',
          mode: 'expression',
          fixture: `corpus/fixtures/seed/${spec.module}/source.${ext}`,
          document: spec.kind,
          moduleId: facts.id,
          internettoolsCommit: '2724779c4287547137141ec9ec2a6df0af0f82af',
          triples: [],
        },
        null,
        2,
      ) + '\n',
    );
    return { module: spec.module, ok: true, reason: 'manifest-only (no static expressions)' };
  }

  const oracleManifest = {
    fixtureId: `seed/${spec.module}/source`,
    moduleId: facts.id,
    document: spec.kind === 'json' ? 'json' : spec.kind === 'xml' ? 'xml' : 'html',
    expressions: expressions.map((e) => ({
      id: e.id,
      expression: e.expression,
      engine: oracleEngine(e.language),
      output: e.output,
    })),
  };
  const omPath = join(outDir, 'oracle-manifest.json');
  const oracleOut = join(outDir, 'triples.json.tmp');
  writeFileSync(omPath, JSON.stringify(oracleManifest, null, 2) + '\n');
  const run = spawnSync(
    CAPTURE_BIN,
    ['expression', bodyFile, omPath, oracleOut],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (run.status !== 0) {
    rmSync(outDir, { recursive: true, force: true });
    return {
      module: spec.module,
      ok: false,
      reason: `oracle failed: ${String(run.stderr).slice(0, 200)}`,
    };
  }
  const triplesDoc: unknown = JSON.parse(readFileSync(oracleOut, 'utf8'));
  writeFileSync(
    join(outDir, 'triples.json'),
    JSON.stringify(triplesDoc, null, 2) + '\n',
  );
  return { module: spec.module, ok: true, reason: `${expressions.length} expressions` };
}

async function main(): Promise<void> {
  const onlyArg = process.argv.indexOf('--only');
  let specs: SeedSpec[] = NAMED_SEEDS;
  if (onlyArg !== -1) {
    const names = (process.argv[onlyArg + 1] ?? '').split(',');
    specs = [...NAMED_SEEDS, ...FILLER_SEEDS, ...SUBSTITUTES].filter((s) =>
      names.includes(s.module),
    );
  } else {
    specs = [...NAMED_SEEDS, ...FILLER_SEEDS, ...SUBSTITUTES];
  }
  const outcomes: SeedOutcome[] = [];
  let okCount = 0;
  for (const spec of specs) {
    const outcome = captureSeed(spec);
    outcomes.push(outcome);
    if (outcome.ok) okCount++;
    console.log(
      `${outcome.ok ? 'OK  ' : 'FAIL'} ${spec.module}: ${outcome.reason ?? ''}`,
    );
    if (okCount >= 55 && outcome.ok) break;
  }
  const namedOk = NAMED_SEEDS.every((s) =>
    outcomes.some((o) => o.module === s.module && o.ok),
  );
  console.log(`\ncaptured ${okCount}/${specs.length}; named-10 all ok: ${namedOk}`);
  if (okCount < 50 || !namedOk) process.exitCode = 1;
}

void main();
