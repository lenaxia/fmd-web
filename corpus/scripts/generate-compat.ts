import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFullCorpus } from '../runner/corpus-loader.js';
import { runCorpus, serializeCorpusReport } from '../runner/replay.js';
import type { NormalizationEngine } from '@fmd/contract';
import { normalizeMangaInfo } from '../../server/src/engine/normalize/udata.js';
import { FontoXPathQueryEngine } from '../../server/src/engine/shims/txquery-shim.js';

/**
 * COMPAT.md generator (Phase-0 exit gate): a GENERATED compatibility
 * table — binding status per contract unit + the corpus replay report
 * (live FontoXPath engine vs FPC oracle) with a root-cause reason for
 * every non-passing case. Regenerate with `npx tsx corpus/scripts/generate-compat.ts`.
 *
 * The replay ALSO writes the machine report (per-module/per-expression
 * pass rates) as docs/corpus-report.json via
 * `serializeCorpusReport` — committed, and byte-stability-pinned by the
 * corpus-live golden test; scripts/ci.sh gate-fails when either
 * committed artifact (COMPAT.md or the report JSON) goes stale.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
void ROOT;
interface GapReason {
  /** Stable case keys this reason covers. */
  readonly matches: readonly string[];
  readonly cause: string;
  readonly tracking: string;
}

/** Curated root causes for the current corpus replay misses. */
const GAP_REASONS: readonly GapReason[] = [
  {
    matches: ['string-join(//text()', 'text-node splitting'],
    cause:
      'Text-node splitting divergence: InternetTools\u2019 repairing parser emits separate text nodes around decoded entities/tags (e.g. "Manhwa " + "&" + " Manhua"), so string-join(//text(), separator) joins more, shorter segments; linkedom keeps the decoded text in single nodes.',
    tracking: 'Phase-1 parser-parity story (preprocessing pass where needed, DESIGN.md \u00a75.6)',
  },
  {
    matches: ['props.books.data()', 'parse-json(//script[@data-page="app"]).props'],
    cause:
      'Oracle/engine divergence on the Hentai2Read app-JSON sub-paths: the FPC oracle recorded EMPTY for books.data()/parse-json(...).props while .props.books.lastPage matched on the SAME document (triple 17#1); the live engine resolves both. Suspected InternetTools-side parse/step limitation on that payload \u2014 needs FPC-harness diagnosis.',
    tracking: 'Phase-1 (corpus harness re-run with per-step probes)',
  },
  {
    matches: ['json(*).genres().name'],
    cause:
      'Oracle empty-detection nuance: the parenthesized sequence (json-steps, concat(...)) carries one empty string; the FPC harness recorded the whole result "" as resultKind "empty", while the runner\u2019s empty check also requires an empty list.',
    tracking: 'Phase-1 (corpus harness encoding; runner semantics intentionally strict)',
  },
  {
    matches: ['norm-0004-prefixstrip', 'norm-0011', 'norm-0021', 'norm-0025', 'getinfo-normalization-0004-prefixstrip', 'getinfo-normalization-0011', 'getinfo-normalization-0021', 'getinfo-normalization-0025'],
    cause:
      '\u00a75.8 pipeline sub-behaviors in flight: manga-name prefix strip (OptionRemoveMangaNameFromChapter), Link fallback details and the unicode cleanup set are being converged in the facades story.',
    tracking: 'tsk-feral-lumber-leaves (Facades: \u00a75.8 post-processing pipeline)',
  },
];

function gapFor(label: string): { cause: string; tracking: string } {
  for (const gap of GAP_REASONS) {
    if (gap.matches.some((m) => label.includes(m))) {
      return { cause: gap.cause, tracking: gap.tracking };
    }
  }
  return { cause: 'UNDOCUMENTED \u2014 root cause required', tracking: 'this story' };
}

/**
 * contract.json binding → COMPAT.md tracker row key. The `--gate` mode
 * asserts EVERY requireShims/facades entry maps to an emitted row — a
 * contract binding without a tracker row is an undocumented omission
 * (D11) and fails the gate.
 */
const BINDING_ROWS: Readonly<Record<string, string>> = {
  'require:fmd.env': 'LuaFMD.pas',
  'require:fmd.crypto': 'LuaCrypto.pas',
  'require:fmd.duktape': 'LuaDuktape.pas',
  'require:fmd.gzip': 'LuaGZip.pas',
  'require:fmd.fileutil': 'LuaFileUtil.pas',
  'require:fmd.imagepuzzle': 'LuaImagePuzzle.pas',
  'require:fmd.logger': 'LuaLogger.pas',
  'require:fmd.mangafoxwatermark': 'LuaMangaFox.pas',
  'require:fmd.pcre2': 'LuaPCRE2.pas',
  'require:fmd.strings': 'LuaStrings.pas',
  'require:pb': 'lua-protobuf (`pb.dll`)',
  'require:subprocess': 'LuaSubprocess.pas',
  'require:utils.* / templates.*': 'lua/utils/ + lua/templates/',
  'facade:TXQuery': 'LuaXQuery.pas / LuaIXQValue.pas',
  'facade:IXQValue': 'LuaXQuery.pas / LuaIXQValue.pas',
  'facade:TStrings': 'LuaStrings.pas',
  'facade:MangaInfo': 'LuaMangaInfo.pas',
  'facade:Storage': 'LuaStringsStorage.pas',
  'facade:HTTP': 'LuaHTTPSend.pas / httpsendthread.pas',
  'facade:Crypto': 'LuaCrypto.pas',
  'facade:ImagePuzzle': 'LuaImagePuzzle.pas',
  'facade:Duktape': 'LuaDuktape.pas',
};

interface ContractDoc {
  readonly requireShims?: readonly { readonly require: string }[];
  readonly facades?: readonly { readonly name: string }[];
}

/**
 * Gate check: every contract.json binding must map to an emitted
 * tracker row. Returns the missing bindings ('kind:id → row|none').
 */
export function missingBindingRows(
  contract: ContractDoc,
  emittedUnits: ReadonlySet<string>,
): string[] {
  const missing: string[] = [];
  const check = (kind: string, id: string, row: string | undefined): void => {
    if (row === undefined || !emittedUnits.has(row)) {
      missing.push(`${kind}:${id} → ${row ?? '(no mapping)'}`);
    }
  };
  for (const r of contract.requireShims ?? []) {
    check('require', r.require, BINDING_ROWS[`require:${r.require}`]);
  }
  for (const f of contract.facades ?? []) {
    check('facade', f.name, BINDING_ROWS[`facade:${f.name}`]);
  }
  return missing;
}

function main(): void {
  const seedDir = join(ROOT, 'corpus', 'fixtures', 'seed');
  const captureDir = join(ROOT, 'corpus', 'fixtures', 'capture');
  const cases = buildFullCorpus(seedDir, captureDir);
  const normalization: NormalizationEngine = {
    name: 'udata-normalize',
    normalize: (input, flags) =>
      normalizeMangaInfo(input, {
        isRemoveHostFromChapterLinks: flags?.['removeHostFromChapterLinks'] ?? true,
        OptionRemoveMangaNameFromChapter:
          flags?.['optionRemoveMangaNameFromChapter'] ?? false,
      }) as unknown as Record<string, unknown>,
  };
  const report = runCorpus(cases, new FontoXPathQueryEngine(null), { normalization });

  const bindingStatus: Readonly<Record<string, { status: string; note: string }>> = {
    HTTP: {
      status: 'implemented',
      note: 'full \u00a75.4 surface (tsk-native-trinket-stencils, mock-server verified): undici-envelope resolver + Document stream facade (ToString/WriteString/Clear/Size, success\u21d4Size>0), ResultCode/ResultString/LastURL, case-insensitive Headers/Cookies Values + cookie jar from Set-Cookie, GET/POST/XHR (+POST MimeType move + text/html\u2192urlencoded rewrite), Terminated, Reset/ResetBasic/AcceptImage default sets (D13 zstd omit), URL massaging + SplitURL + redirect Location merge, redirect-follow (301/302/303/307 AS GET, Referer, MaxRedirect 5) + retry >500 bounded RetryCount + abort fail-fast, SetProxy HTTP|SOCKS4|SOCKS5, per-host connection gate (limits/delays), egress policy (RFC1918/link-local denied by default, allow-list override). Transport backends: recorded (offline) + loopback (integration/live smoke); the production non-loopback transport lands with the Phase-2 server runtime.',
    },
    TXQuery: {
      status: 'implemented',
      note: '\u00a75.6 full surface (oracle-verified: 100% of the seed expression corpus) \u2014 FontoXPath 3.1 + linkedom behind the InternetTools dialect transform: json()/parse-json() NODE TREES (objects \u2192 key elements, arrays \u2192 item elements, typed scalar leaves), .step shorthand, chained name()() member steps, ?map lookups, css(), fmd:not (JSONiq EBV), fmd:string/fmd:string-join (XQGlobalTrimNodes), repairing-parser preprocessing (CRLF\u2192LF, adjacent-text merge, comment/PI drop, post-</body> text skip, bare-payload scaffold, literal CR normalization), list-fill overloads (XPathStringAll(expr[,node,]list), XPathHREFAll/XPathHREFTitleAll \u2192 TStrings mutation, order preserved), ParseHTML 1-arg reparse, swallow-to-empty + per-(module,expression) WARN dedupe.',
    },
    IXQValue: {
      status: 'implemented',
      note: 'Get() iterator / Get(i) / GetProperty / GetAttribute / ToString inner-text / Count (facade tables stay Lua-side; JS-registered ids resolve via glue).',
    },
    TStrings: { status: 'implemented', note: 'Full \u00a75.5 surface (facades story).' },
    MangaInfo: { status: 'implemented', note: '\u00a75.2 field surface + unknown-key tolerance (facades story).' },
    Storage: { status: 'implemented', note: '\u00a75.3 shared KV via the state service (facades story).' },
    Crypto: { status: 'implemented', note: 'full LuaCrypto surface (LuaCrypto.pas:429\u2013494): node:crypto + sodium-native + pure-JS RC4/MD4, vectors in server/test/engine/shims/crypto-*.test.ts.' },
    Duktape: {
      status: 'implemented',
      note: 'v0: node:vm (5 s timeout), one heap per ExecJS (duk_peval semantics: completion value, JSON text for object/array results), Duktape.enc/dec polyfill, CommonJS require (module/exports, cached, jailed to the synced lua tree), error\u21d2nil, print\u2192host log.',
    },
    pb: {
      status: 'implemented',
      note: 'protobufjs-backed package.preload["pb"] behind a byte-exact base64 Lua bridge (wasmoon marshals Lua strings as UTF-8 with NUL truncation — lossy for descriptor wire bytes; see the byte-strings note below). load = the lua-protobuf two-value contract: (ret, pos) = (boolean, integer) per the README pb-module table and pb.c Lpb_load — ALWAYS two values, 1-based pb_pos+1 (success = byte length+1; failure ret=false, not nil, pos = the parse-stop offset that protoc.lua:1178 concatenates). Serialized-FileDescriptorSet input only (native parity — protoc.lua is the text→descriptor compiler; no raw .proto-text path); google.protobuf descriptors preloaded eagerly (Parser.reload parity, protoc.lua:1143-1145/1188) so protoc:compile\u2019s pb.encode(\'.google.protobuf.FileDescriptorSet\u2019, \u2026) works. decode: proto3 defaults + enum-as-name (lua-protobuf enum_as_name default; MangaPlus.lua:129 GetLang), absent message fields \u2192 nil. Verified end-to-end by server/test/engine/shims/pb-protoc.integration.test.ts: the real utils/protoc.lua has_pb branch + Parser.reload through the shim, protoc:load(MangaPlus.proto) binding (ret, pos), golden recorded-Response replay (evidence: docs/evidence-pb-fidelity.md).',
    },
    'fmd.env': { status: 'implemented', note: 'v0: ExeName/Version/Revision/LuaDirectory/SelectedLanguage/Directory.' },
    'fmd.fileutil': { status: 'partial (gap: SerializeAndMaintainNames)', note: 'implemented: ExtractFileName/ExtractFileNameOnly; GAP: SerializeAndMaintainNames (1/418 tree modules, 0 seed modules call it).' },
    'fmd.imagepuzzle': { status: 'implemented', note: 'raw-pixel port of ImagePuzzle.pas:136-305 (imagepuzzle-core.ts + imagepuzzle-shim.ts package-preload; node:zlib PNG codec — sharp is uninstallable in this offline workspace): New/Create(w,h), HorBlock/VerBlock, Matrix[]/Flips[]/Multiply, DeScramble(src,dst) incl. in-place same-Document and non-square grids; ≥3 real-site goldens pixel-identical (corpus/fixtures/imagepuzzle; evidence: docs/evidence-shims-image.md); loader-registered (require-registry runtime-tested).' },
    'fmd.pcre2': { status: 'implemented', note: 'API-faithful TLuaPCRE2Engine facade: exec/find/match/gmatch/gsub (LuaPCRE2.pas:237-245), PCRE2_UTF always on, V8 RegExp backend (pcre2-shim.ts).' },
    'fmd.gzip': { status: 'implemented', note: 'one method Inflate (LuaGZip.pas:47-50 + GZIPUtils.pas unzipStream): gzip/zlib/raw-deflate auto-detect, checksum-verified, failure → nil, never raises (gzip-shim.ts).' },
    'fmd.logger': { status: 'implemented', note: 'complete LuaLogger surface (LuaLogger.pas:33-45): Send/SendWarning/SendError routed to the module-correlated structured host logger with luaToString argument parity (logger-shim.ts).' },
    'fmd.mangafoxwatermark': { status: 'implemented', note: 'raw-pixel port of MangaFoxWatermark.pas (mangafoxwatermark-core.ts + -shim.ts host-lib): Otsu/PSNR matcher, white-border check, crop+rewrite; the REAL PNG template assets ship into the synced-tree layout (corpus/fixtures/lua/extras/mangafoxtemplate); Windows backslash path translation (FanFox.lua:36); FanFox.lua OnAfterImageSaved flow verified offline (evidence: docs/evidence-shims-image.md).' },
    subprocess: { status: 'deferred', note: 'denied stub unless the browser profile (\u00a75.11; cost: 0/418 tree modules require it).' },
    'utils.* / templates.*': {
      status: 'implemented',
      note: 'file-package loader from the synced lua tree (dots\u2192slashes, package.loaded caching); utils.nodejs \u00a75.11 sidecar pending.',
    },
  };

  // The tracker table lives at the top of the existing document; statuses
  // are UPDATED in place (the document is curated + generated hybrid).
  const compatPath = join(ROOT, 'docs', 'COMPAT.md');
  const existing = existsSync(compatPath) ? readFileSync(compatPath, 'utf8') : '';

  const lines: string[] = [];
  lines.push('# COMPAT.md \u2014 per-binding-unit compatibility tracker (DESIGN.md \u00a75)');
  lines.push('');
  lines.push('Status vocabulary (Phase-1 gate): `implemented` · `partial (gap: …)` ·');
  lines.push('`deferred` — every deferral records its module-count cost (D11: nothing');
  lines.push('dropped silently). Cost counts scan the FMD2 lua tree (418 module files)');
  lines.push('and the ≥50-module seed corpus (67 captured modules).');
  lines.push('');
  lines.push('> Binding statuses and the corpus-replay sections are');
  lines.push('> GENERATED by `corpus/scripts/generate-compat.ts`; curated notes');
  lines.push('> below the marker are preserved across regenerations.');
  lines.push('');
  lines.push('| FMD2 unit | Boundary | Status | Notes |');
  lines.push('|---|---|---|---|');
  // tracker rows keyed by FMD2 unit, boundary text preserved from the scaffold
  const unitStatus: Readonly<Record<string, { status: string; note: string }>> = {
    'LuaBase.pas': { status: 'implemented', note: '\u00a75.1 Init globals (print, sleep, Trim, MaybeFillHost, MangaInfoStatusIfPos, GetBetween, SeparateLeft/Right)' },
    'LuaWebsiteModules.pas': {
      status: 'implemented',
      note: '\u00a75.1\u20135.2 module surface + generated \u00a75.2 dispatchers (contract.json as data); module cookie methods implemented over the \u00a75.3 per-module shared cookie jar (audit F-2): AddServerCookies(text) parses newline-split Set-Cookie lines (first pair = the cookie, attributes dropped; \'; \'-joined MODULE.Account.Cookies lists accepted too \u2014 Madokami parity), GetServerCookies(name) \u2192 value (\'\' \u2192 the \'; \'-joined store), RemoveCookies(nameOrList)/no-arg clears the store (SoftKomik logout), ClearCookies \u2014 the same jar backs every module HTTP object\'s request-cookie injection and persists via module_state (restart round-trip); real SoftKomik.lua + Madokami.lua flows verified offline (server/test/engine/e2e/module-cookies.e2e.test.ts)',
    },
    'LuaWebsiteModuleHandler.pas': { status: 'implemented', note: '\u00a75.3/\u00a75.12 chunk re-exec on module switch' },
    'LuaWebsiteBypass.pas + checkantibot.lua': {
      status: 'implemented',
      note: '\u00a75.9 host-level antibot interceptor: checkAntiBot heuristic (checkantibot.lua:5-12) + AntiBotInterceptor (global check serialization :94-115, per-module single-flight fallthrough :161/197-200, cookie clear-then-persist :177/:182-183, reload re-issue :184-188, AllowServerErrorResponse forced :156) \u2014 unit-tested (server/test/engine/state/antibot.test.ts) AND integration-tested offline (server/test/engine/state/antibot.pipeline.integration.test.ts): the REAL FMD2 bypass scripts (checkantibot.lua + websitebypass.lua \u2192 cloudflare.lua, require chain incl. fmd.duktape ExecJS + fmd.crypto.EncodeURLElement + utils.json) run in a real wasmoon engine against the corpus/fixtures/antibot mock server \u2014 signature matrix, IUAM challenge (answer validated \u2192 duktape shim exercised), FlareSolverr reload flow (Storage[reload]=true \u2192 re-issue), and \u22658-worker single-flight concurrency (exactly one bypass, losers not delayed); evidence: docs/evidence-antibot-integration.md.',
    },
    'LuaHTTPSend.pas / httpsendthread.pas': { status: 'implemented', note: bindingStatus['HTTP']?.note ?? '\u00a75.4' },
    'LuaStrings.pas': { status: 'implemented', note: '\u00a75.5 full facade surface' },
    'LuaXQuery.pas / LuaIXQValue.pas': { status: 'implemented', note: bindingStatus['TXQuery']?.note ?? '\u00a75.6' },
    'LuaCrypto.pas': { status: 'implemented', note: '\u00a75.7 full surface (LuaCrypto.pas:429\u2013494): node:crypto + sodium-native + pure-JS RC4/MD4; vectors in server/test/engine/shims/crypto-*.test.ts \u2014 details below' },
    'LuaDuktape.pas': { status: 'implemented', note: bindingStatus['Duktape']?.note ?? '\u00a75.7' },
    'LuaGZip.pas': { status: 'implemented', note: 'one method Inflate (LuaGZip.pas:47-50 + GZIPUtils.pas unzipStream): gzip/zlib/raw-deflate auto-detect, checksum-verified (CRC32/ISIZE, Adler-32), failure → nil with the Pascal’s log line, never raises (gzip-shim.ts).' },
    'LuaFileUtil.pas': { status: 'partial (gap: SerializeAndMaintainNames)', note: bindingStatus['fmd.fileutil']?.note ?? '\u00a75.7' },
    'LuaImagePuzzle.pas': { status: 'implemented', note: 'raw-pixel port (imagepuzzle-core.ts, line-by-line ImagePuzzle.pas:136-305 port + imagepuzzle-shim.ts package-preload): New/Create(w,h), HorBlock/VerBlock, Matrix[]/Flips[]/Multiply, DeScramble(src,dst) incl. in-place — cost note retired: 7/418 tree modules require it, 2/67 seed modules (18Comic, MangaGo).' },
    'LuaPCRE2.pas': { status: 'implemented', note: 'API-faithful TLuaPCRE2Engine facade: exec/find/match/gmatch/gsub (LuaPCRE2.pas:237-245), PCRE2_UTF always on, V8 RegExp backend — pcre2-shim.ts; expressibility ledger in the fmd.pcre2 compatibility notes below.' },
    'LuaStringsStorage.pas': { status: 'implemented', note: '\u00a75.1/\u00a75.3 MODULE.Storage via the shared state service' },
    'lua-protobuf (`pb.dll`)': { status: 'implemented', note: bindingStatus['pb']?.note ?? 'D17' },
    'LuaFMD.pas': { status: 'implemented', note: bindingStatus['fmd.env']?.note ?? '\u00a75.1' },
    'LuaLogger.pas': { status: 'implemented', note: bindingStatus['fmd.logger']?.note ?? 'structured logging' },
    'LuaMangaFox.pas': { status: 'implemented', note: bindingStatus['fmd.mangafoxwatermark']?.note ?? 'raw-pixel port of MangaFoxWatermark.pas + REAL PNG assets in the synced-tree layout; Windows backslash path translation (host-lib loader)' },
    'LuaMangaInfo.pas': { status: 'implemented', note: bindingStatus['MangaInfo']?.note ?? '\u00a75.2 field surface' },
    'lua/utils/ + lua/templates/': { status: 'implemented', note: bindingStatus['utils.* / templates.*']?.note ?? 'file-package loader' },
    'LuaSubprocess.pas': { status: 'deferred', note: 'denied stub unless the browser profile (\u00a75.10\u20135.11) \u2014 cost: 0/418 tree modules require it.' },
    'uData.pas': { status: 'implemented', note: '\u00a75.8 pipeline oracle-verified: 100% of the seed normalization corpus (flag-faithful \u2014 per-capture removeHostFromChapterLinks / OptionRemoveMangaNameFromChapter honored).' },
    'uFavoritesManager.pas': { status: 'deferred', note: '\u00a77.2 (DoCheck parity) \u2014 cost: Phase-4 epic scope (favorites engine; no shim binding).' },
    'uDownloadsManager.pas': { status: 'deferred', note: '\u00a77.1/\u00a77.3 (streaming packers, D16) \u2014 cost: Phase-3 epic scope (download engine; no shim binding).' },
  };
  const boundaries: Readonly<Record<string, string>> = {
    'LuaBase.pas': 'Init globals (`print`, `sleep`, `Trim`, \u2026)',
    'LuaWebsiteModules.pas': 'module surface + 15 event dispatchers',
    'LuaWebsiteModuleHandler.pas': 'chunk re-exec on module switch',
    'LuaWebsiteBypass.pas + checkantibot.lua': 'antibot interceptor + websitebypass (OnHTTPRequest hook)',
    'LuaHTTPSend.pas / httpsendthread.pas': '`HTTP` shim',
    'LuaStrings.pas': 'TStrings facade',
    'LuaXQuery.pas / LuaIXQValue.pas': 'CreateTXQuery + IXQValue',
    'LuaCrypto.pas': 'fmd.crypto',
    'LuaDuktape.pas': 'fmd.duktape ExecJS + JS require',
    'LuaGZip.pas': 'fmd.gzip Inflate',
    'LuaFileUtil.pas': 'fmd.fileutil',
    'LuaImagePuzzle.pas': 'fmd.imagepuzzle',
    'LuaPCRE2.pas': 'fmd.pcre2',
    'LuaStringsStorage.pas': 'MODULE.Storage',
    'lua-protobuf (`pb.dll`)': '`pb` preload shim',
    'LuaFMD.pas': '`fmd.env` host lib',
    'LuaLogger.pas': '`fmd.logger` structured logging',
    'LuaMangaFox.pas': '`fmd.mangafoxwatermark`',
    'LuaMangaInfo.pas': '`MANGAINFO` facade',
    'lua/utils/ + lua/templates/': '`utils.*` / `templates.*` file packages',
    'LuaSubprocess.pas': 'subprocess',
    'uData.pas': 'GetInfo post-processing',
    'uFavoritesManager.pas': 'favorites engine',
    'uDownloadsManager.pas': 'download pipeline + packing',
  };
  for (const [unit, s2] of Object.entries(unitStatus)) {
    lines.push(`| ${unit} | ${boundaries[unit] ?? ''} | ${s2.status} | ${s2.note} |`);
  }
  lines.push('');
  lines.push('## Corpus replay (live engine vs FPC oracle, \u00a713.1)');
  lines.push('');
  lines.push(`- Engine: **${report.engine}** (FontoXPath + linkedom behind the dialect transform)`);
  lines.push(`- Normalization: **${report.normalization}** (\u00a75.8 uData pipeline)`);
  lines.push(`- Cases: ${report.summary.cases} \u00b7 passed: ${report.summary.passed} \u00b7 failed: ${report.summary.failed}`);
  lines.push(`- **Pass rate: ${(report.summary.passRate * 100).toFixed(2)}%** (gate: \u226599%)`);
  lines.push('');
  lines.push('### Per-module pass rates');
  lines.push('');
  lines.push('Expression cases per seed module (report.modules rollup), plus the');
  lines.push('uData \u00a75.8 normalization rollup \u2014 the aggregate above is the sum.');
  lines.push('');
  lines.push('| Module | Cases | Passed | Failed | Rate |');
  lines.push('|---|---|---|---|---|');
  for (const mod of report.modules) {
    const total = mod.passed + mod.failed;
    const rate = total === 0 ? 0 : mod.passed / total;
    lines.push(
      `| ${mod.module} | ${total} | ${mod.passed} | ${mod.failed} | ${(rate * 100).toFixed(2)}% |`,
    );
  }
  const normTotal = report.normalizations.length;
  const normPassed = report.normalizations.filter((n) => n.status === 'pass').length;
  const normRate = normTotal === 0 ? 0 : normPassed / normTotal;
  lines.push(
    `| uData (\u00a75.8 normalization) | ${normTotal} | ${normPassed} | ${normTotal - normPassed} | ${(normRate * 100).toFixed(2)}% |`,
  );
  lines.push('');
  lines.push('### Per-expression results');
  lines.push('');
  lines.push('| Module | Case | Expression | Status | Expected | Actual | Root cause | Tracking |');
  lines.push('|---|---|---|---|---|---|---|---|');
  const seenKeys = new Set<string>();
  for (const mod of report.modules) {
    for (const c of mod.cases) {
      if (c.status === 'pass') {
        continue;
      }
      const label = `${c.expression.expression}`;
      const key = `${mod.module}|${label}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      const gap = gapFor(label);
      const cell = (v: string): string => v.replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ').slice(0, 70);
      lines.push(
        `| ${mod.module} | ${c.expression.id} | \`${cell(label)}\` | ${c.status} | ${cell(JSON.stringify(c.expected))} | ${cell(JSON.stringify(c.actual))} | ${gap.cause} | ${gap.tracking} |`,
      );
    }
  }
  for (const n of report.normalizations) {
    if (n.status === 'pass') {
      continue;
    }
    const gap = gapFor(n.fixtureId);
    const ncell = (v: string): string => v.replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ').slice(0, 70);
    lines.push(
      `| uData (\u00a75.8) | ${n.fixtureId.replace('capture/getinfo-normalization-', 'norm-')} | normalize | ${n.status} | ${ncell(JSON.stringify(n.expected))} | ${ncell(JSON.stringify(n.actual))} | ${gap.cause} | ${gap.tracking} |`,
    );
  }
  lines.push('');
  lines.push('### Known behavioral divergences (v0, documented)');
  lines.push('');
  lines.push('1. **CSS selector engine** \u2014 `css()` runs linkedom\u2019s css-select (CSS3); InternetTools\u2019 css3 subset differences (e.g. `:has`) degrade to swallowed-empty per FMD2 semantics.');
  lines.push('2. **JSON node tree** \u2014 objects \u2192 key-named child elements, arrays \u2192 `item` child elements, typed scalar leaves (string/number/boolean/null markers); `name()` member steps rewrite to `/*` (chained `name()()` to nested member steps), `?key` to `/key`; `not(` rewrites to `fmd:not(` carrying InternetTools\u2019 JSONiq EBV (false/0/""/null \u2192 false). KNOWN GAP: a BARE `[prop]` predicate over a JSON tree keeps standard node EBV (always true) instead of the boxed-value EBV \u2014 FMD2 modules express the filter as `not(prop)`; unexercised by the seed corpus.');
  lines.push('3. **EHentai.lua:71 `.x` field** \u2014 reads a nonexistent TXQuery field (`CreateTXQuery(...).x`); FMD2 errors identically (LuaClass `__index` unknown key \u2192 nil). The host records the failed dispatch; the update thread keeps the default page count (uUpdateThread.pas:198).');
  lines.push('4. **Parser preprocessing (corpus-proven divergences only)** \u2014 CRLF/CR \u2192 LF in text and attributes (parseTextAttribute/parseCDATA normalization); adjacent text nodes merged (readText append semantics \u2014 character references never split runs); comments/PIs dropped (readComments/readPIs = false); whitespace text after `</body>` skipped (bpmAfterBody); bare text payloads scaffolded into html/head/body (repairing parser); XQuery string literals normalize CR \u2192 LF (LineEndingNormalization xqlenXML1). Implicit node\u2192string coercion inside OTHER XPath functions (substring/upper-case over elements) uses fontoxpath\u2019s raw string value \u2014 the seed corpus proves no divergence there.');
  lines.push('5. **TASK.CurrentDownloadChapterPtr / TASK.CurrentMaxFileNameLength = 0 \u2014 the one-chapter-per-job EQUIVALENCE (audit N-2)** \u2014 fmd-web runs one chapter per download job where FMD2 walks a chapter list, so the host returns the constants 0. Readers get IDENTICAL links: FMD2\u2019s Pascal `Strings[i]` is 0-based (LuaStrings.pas:88), so `TASK.ChapterLinks[TASK.CurrentDownloadChapterPtr]` resolves slot 0 \u2014 the same link fmd-web\u2019s seeded TASK carries; EHentai.lua:156\u2019s length limit check is correctly INERT with 0 = no limit, and the host-side D5 truncation owns the filename length limit (read by ~10 modules + 2 templates: MangaFire.lua:324, DataLife.lua:112, \u2026).');
  lines.push('');
  lines.push('## Seed e2e flows (Phase-0 exit evidence)');
  lines.push('');
  lines.push('Committed goldens under `server/test/engine/golden/e2e/`: comick-getinfo, asurascans-getinfo, hentai2read-getpagenumber (+ PAGENUMBER read-back 1752 on the RECORDED fixture), madara-template-getpagenumber (Duktape JS require + AES decrypt), ehentai-getinfo-login (account constants + MODULE.Account + module-bug parity), tapas-totaldirectory.');

  // Preserve curated sections that follow the marker (e.g. the crypto
  // story's compatibility notes) across regenerations. Trailing whitespace
  // is normalized so repeated runs stay byte-stable (the write below adds
  // the final newline).
  const MARKER = '## fmd.crypto compatibility notes';
  const markerIdx = existing.indexOf(MARKER);
  const curated = markerIdx >= 0 ? `\n${existing.slice(markerIdx).replace(/\s+$/u, '')}\n` : '';
  mkdirSync(dirname(compatPath), { recursive: true });
  writeFileSync(compatPath, `${lines.join('\n')}${curated}`);
  const reportPath = join(ROOT, 'docs', 'corpus-report.json');
  writeFileSync(reportPath, serializeCorpusReport(report));
  console.log(
    `COMPAT.md written: ${report.summary.passed}/${report.summary.cases} = ${(report.summary.passRate * 100).toFixed(2)}% ` +
    `(docs/corpus-report.json: ${report.summary.cases} cases, ${report.modules.length} modules)`,
  );

  // --gate (scripts/ci.sh corpus step): the Phase-1 gate — pass rate must
  // be ≥99% AND every non-passing case must carry a curated root cause.
  if (process.argv.includes('--gate')) {
    const failures: string[] = [];
    for (const mod of report.modules) {
      for (const c of mod.cases) {
        if (c.status !== 'pass' && gapFor(c.expression.expression).cause.startsWith('UNDOCUMENTED')) {
          failures.push(`${mod.module}: ${c.expression.id}`);
        }
      }
    }
    for (const n of report.normalizations) {
      if (n.status !== 'pass' && gapFor(n.fixtureId).cause.startsWith('UNDOCUMENTED')) {
        failures.push(`uData: ${n.fixtureId}`);
      }
    }
    if (report.summary.passRate < 0.99) {
      console.error(
        `corpus gate FAILED: pass rate ${(report.summary.passRate * 100).toFixed(2)}% < 99%`,
      );
      process.exit(1);
    }
    if (failures.length > 0) {
      console.error(
        `corpus gate FAILED: ${failures.length} undocumented mismatch(es):\n  ${failures.join('\n  ')}`,
      );
      process.exit(1);
    }
    // Contract-coverage gate: every contract.json binding must have an
    // emitted tracker row (17/22-style omissions fail here).
    const contract: ContractDoc = JSON.parse(
      readFileSync(join(ROOT, 'contract', 'contract.json'), 'utf8'),
    ) as ContractDoc;
    const emitted = new Set(Object.keys(unitStatus));
    const missingRows = missingBindingRows(contract, emitted);
    if (missingRows.length > 0) {
      console.error(
        `corpus gate FAILED: ${missingRows.length} contract binding(s) without a COMPAT.md tracker row:\n  ${missingRows.join('\n  ')}`,
      );
      process.exit(1);
    }
    console.log('corpus gate passed: >=99% with zero undocumented mismatches');
  }
}

// Run as CLI only when executed directly — importing this module (e.g.
// from tooling) must not regenerate docs/ or exit on the gate.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main();
}
