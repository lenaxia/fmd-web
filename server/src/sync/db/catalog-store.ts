/**
 * Catalog read side (DESIGN.md §6.4–§6.6).
 *
 * Read policy (§6.4): catalog files are rollback-journal SQLite written
 * by FMD2's desktop pipeline and NEVER written again after install.
 * Every catalog connection opens with SQLITE_OPEN_READONLY
 * (`readonly: true, fileMustExist: true` — better-sqlite3's mechanism
 * for the `file:...?mode=ro` URI invariant: the flag passes straight
 * to sqlite3_open_v2, so a read connection physically cannot write the
 * file, create a rollback journal, or create the db). A regression test
 * asserts a full search workload leaves zero `-journal`/`-wal`/`-shm`
 * sidecars next to the catalogs and the files byte-identical.
 *
 * FTS5 sidecar (§6.5): `data/fts/<ID>.db` keyed by the catalog
 * `db_sha`. Replacement is double-buffered: the fresh sidecar is built
 * complete at a temp path and moved in with an atomic rename — readers
 * holding the previous sidecar's open handle keep reading that (old)
 * buffer and finish deterministically; the next open sees the new one.
 *
 * Browsing (§6.6): `latest` (jdn DESC), `title` (title ASC) straight
 * off the read-only catalog; FTS search with cursor pagination.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, type Hash } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  CatalogBrowseQuery,
  CatalogEntry,
  CatalogMeta,
  CatalogPage,
  CatalogSearchQuery,
  CatalogStore,
  ModuleId,
} from '@fmd/contract';
import { dateToJdn } from './jdn.js';

/** Page bounds (§10 `page=` / FTS cursors). */
export const CATALOG_PAGE_DEFAULT = 20;
export const CATALOG_PAGE_MAX = 200;

/** Module IDs are 32-hex (§5); anything else is refused (path safety). */
export function isValidCatalogId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}

function assertValidId(id: string): void {
  if (!isValidCatalogId(id)) {
    throw new Error(`invalid catalog id: ${id}`);
  }
}

function catalogPath(dataDir: string, id: ModuleId): string {
  assertValidId(id);
  return path.join(dataDir, 'catalogs', `${id}.db`);
}

function metaPath(dataDir: string, id: ModuleId): string {
  assertValidId(id);
  return path.join(dataDir, 'catalogs', `${id}.meta.json`);
}

function ftsPath(dataDir: string, id: ModuleId): string {
  assertValidId(id);
  return path.join(dataDir, 'fts', `${id}.db`);
}

/** sha256 hex of a file's bytes (the `db_sha` key, §9). */
export function fileSha256(file: string): string {
  const hash: Hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

interface CatalogHandle {
  readonly db: Database.Database;
  readonly dbSha: string;
  readonly identity: string;
}

interface SidecarHandle {
  readonly db: Database.Database;
  readonly dbSha: string;
}

interface InstallReceipt {
  dbSha?: string;
  fetchedAt?: string;
}

/** Catalog row exactly as stored (`DBDataProcess.pas:137-153`). */
interface CatalogRow {
  readonly link: string;
  readonly title: string | null;
  readonly alttitles: string | null;
  readonly authors: string | null;
  readonly artists: string | null;
  readonly genres: string | null;
  readonly status: string | null;
  readonly summary: string | null;
  readonly numchapter: number | null;
  readonly jdn: number | null;
}

function toEntry(row: CatalogRow): CatalogEntry {
  return {
    link: row.link,
    title: row.title ?? '',
    alttitles: row.alttitles ?? '',
    authors: row.authors ?? '',
    artists: row.artists ?? '',
    genres: row.genres ?? '',
    status: row.status ?? '',
    summary: row.summary ?? '',
    numChapter: row.numchapter ?? 0,
    jdn: row.jdn ?? 0,
  };
}

const PAGE_SQL =
  '"link","title","alttitles","authors","artists","genres","status","summary","numchapter","jdn"';

export class CatalogFileStore implements CatalogStore {
  private readonly dataDir: string;
  private readonly catalogHandles: Map<ModuleId, CatalogHandle> = new Map();
  private readonly sidecarHandles: Map<ModuleId, SidecarHandle> = new Map();

  constructor(paths: { readonly dataDir: string }) {
    this.dataDir = paths.dataDir;
  }

  // ── install receipts (§9 catalog_meta until app.db lands) ─────────

  /** Write the install receipt AFTER the catalog rename landed (atomic
   * temp+rename JSON write); a db without a receipt self-heals (sha
   * recomputed from the file). */
  writeInstallReceipt(id: ModuleId, dbSha: string, fetchedAt: string): void {
    const file: string = metaPath(this.dataDir, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp: string = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ dbSha, fetchedAt }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  /** Install state; self-heals from the db file when the receipt is
   * missing (crash between rename and receipt write). */
  getMeta(catalogId: ModuleId): CatalogMeta | undefined {
    const file: string = catalogPath(this.dataDir, catalogId);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return undefined;
    }
    let receipt: InstallReceipt = {};
    try {
      receipt = JSON.parse(fs.readFileSync(metaPath(this.dataDir, catalogId), 'utf8')) as InstallReceipt;
    } catch {
      // absent receipt → derive everything from the file itself
    }
    const dbSha: string = receipt.dbSha ?? fileSha256(file);
    const fetchedAt: string = receipt.fetchedAt ?? new Date(st.mtimeMs).toISOString();
    return { id: catalogId, dbSha, fetchedAt, bytes: st.size };
  }

  /** Drop cached handles for one catalog — called after a fresh install
   * (new db_sha) so NEW reads open the new file. Any in-flight reader
   * keeps its old handle (rename semantics) and stays deterministic. */
  invalidate(catalogId: ModuleId): void {
    const handle: CatalogHandle | undefined = this.catalogHandles.get(catalogId);
    if (handle !== undefined) {
      this.catalogHandles.delete(catalogId);
      handle.db.close();
    }
    const sidecar: SidecarHandle | undefined = this.sidecarHandles.get(catalogId);
    if (sidecar !== undefined) {
      this.sidecarHandles.delete(catalogId);
      sidecar.db.close();
    }
    try {
      fs.rmSync(metaPath(this.dataDir, catalogId), { force: true });
    } catch {
      // best effort
    }
  }

  // ── read-only catalog access (§6.4) ────────────────────────────────

  /** Open (and cache) the catalog db strictly READ-ONLY. The cache key
   * is the file identity (size + mtime); a replaced catalog forces a
   * fresh open for new readers while the old handle stays valid for
   * whoever still holds it. */
  private openCatalog(catalogId: ModuleId): CatalogHandle {
    const file: string = catalogPath(this.dataDir, catalogId);
    const st: fs.Stats = fs.statSync(file);
    const identity: string = `${st.size}:${st.mtimeMs}`;
    const cached: CatalogHandle | undefined = this.catalogHandles.get(catalogId);
    if (cached !== undefined && cached.identity === identity) {
      return cached;
    }
    if (cached !== undefined) {
      this.catalogHandles.delete(catalogId);
      cached.db.close();
    }
    const db: Database.Database = new Database(file, {
      readonly: true,
      fileMustExist: true,
    });
    const handle: CatalogHandle = { db, dbSha: fileSha256(file), identity };
    this.catalogHandles.set(catalogId, handle);
    return handle;
  }

  /** Latest updates — `ORDER BY jdn DESC` (§6.6). */
  latest(catalogId: ModuleId, query: CatalogBrowseQuery = {}): CatalogPage {
    const handle: CatalogHandle = this.openCatalog(catalogId);
    const { limit, offset } = pageBounds(query);
    const rows: CatalogRow[] = handle.db
      .prepare(
        `SELECT ${PAGE_SQL} FROM masterlist
         ORDER BY "jdn" DESC, "title" COLLATE NOCASE ASC, "link" ASC
         LIMIT ? OFFSET ?`,
      )
      .all(limit + 1, offset) as CatalogRow[];
    return orderedPage(handle.db, rows, limit, offset);
  }

  /** By title (§6.6; NOCASE + link tiebreak for a deterministic order). */
  byTitle(catalogId: ModuleId, query: CatalogBrowseQuery = {}): CatalogPage {
    const handle: CatalogHandle = this.openCatalog(catalogId);
    const { limit, offset } = pageBounds(query);
    const rows: CatalogRow[] = handle.db
      .prepare(
        `SELECT ${PAGE_SQL} FROM masterlist
         ORDER BY "title" COLLATE NOCASE ASC, "link" ASC
         LIMIT ? OFFSET ?`,
      )
      .all(limit + 1, offset) as CatalogRow[];
    return orderedPage(handle.db, rows, limit, offset);
  }

  // ── FTS5 sidecar (§6.5) + search (§6.6/§10) ───────────────────────

  /** FTS search with cursor pagination. Sidecar rebuilds (db_sha
   * mismatch) are double-buffered: concurrent readers of the previous
   * sidecar keep their open handle and finish deterministically.
   *
   * FMD2 Filter-panel parity (additive): beside the legacy `genre`
   * FTS-phrase filter, row filters compose AFTER the MATCH clause —
   * status equality, authors LIKE-contains, genres[] multi with
   * ANY→OR / ALL→AND of LIKE-contains (DBDataProcess.pas:1416-1427),
   * and the only-new jdn window (:1382-1385). With `q` absent the
   * MATCH clause is skipped entirely and the page serves the filtered
   * `entry` table ordered by jdn DESC (latest parity). */
  search(catalogId: ModuleId, query: CatalogSearchQuery): CatalogPage {
    const sidecar: SidecarHandle = this.ensureSidecar(catalogId);
    const rawQ: string = query.query ?? '';
    const match: string | undefined = rawQ === '' ? undefined : buildMatchQuery(rawQ);
    const filters: SearchRowFilters = {
      ...(query.status !== undefined && query.status !== '' ? { status: query.status } : {}),
      ...(query.authors !== undefined && query.authors !== '' ? { authors: query.authors } : {}),
      ...(query.genres !== undefined && query.genres.length > 0 ? { genres: query.genres } : {}),
      genresMode: query.genresMode ?? 'all',
      ...(query.newDays !== undefined ? { newDays: query.newDays } : {}),
    };
    const genre: string | undefined = query.genre;

    // Cursor binding: a cursor carries the query + FULL filter state it
    // was issued for — reusing it against any other combination is
    // rejected, never silently re-paged (pagination stays
    // deterministic).
    const { limit, offset, cursor } = decodeSearchCursor(query);
    if (cursor !== undefined && !searchCursorMatches(cursor, match, genre, filters)) {
      throw new Error('cursor does not match the issued query');
    }
    const genreFilter: string =
      genre === undefined || genre === '' ? '' : ` AND genres : "${escapeFtsPhrase(genre)}"`;
    const fullMatch: string | undefined =
      match === undefined ? undefined : `(${match})${genreFilter}`;

    const rowFilters: { sql: string; params: readonly (string | number)[] } =
      composeRowFilters(filters);
    const withMatch: boolean = fullMatch !== undefined;
    const sql: string = `
      SELECT e."link" AS link, e."title" AS title, e."alttitles" AS alttitles,
             e."authors" AS authors, e."artists" AS artists, e."genres" AS genres,
             e."status" AS status, e."summary" AS summary,
             e."numchapter" AS numchapter, e."jdn" AS jdn
      ${withMatch ? 'FROM search_index s JOIN entry e ON e.rowid = s.rowid' : 'FROM entry e'}
      ${withMatch ? 'WHERE search_index MATCH ?' : 'WHERE 1=1'}${rowFilters.sql}
      ORDER BY ${withMatch ? 'rank, e.rowid' : 'e."jdn" DESC, e.rowid'}
      LIMIT ? OFFSET ?`;
    const params: (string | number)[] = withMatch ? [fullMatch as string] : [];
    params.push(...rowFilters.params, limit + 1, offset);
    const rows: CatalogRow[] = sidecar.db.prepare(sql).all(...params) as CatalogRow[];

    const hasMore: boolean = rows.length > limit;
    const entries: CatalogEntry[] = (hasMore ? rows.slice(0, limit) : rows).map(toEntry);
    const page: CatalogPage = {
      entries,
      total: countMatches(sidecar.db, fullMatch, filters),
    };
    if (hasMore) {
      return {
        ...page,
        nextCursor: encodeSearchCursor(match ?? '', offset + limit, genre ?? '', filters),
      };
    }
    return page;
  }

  /** Open the FTS sidecar for `catalogId`, rebuilding it (atomically,
   * double-buffered) when its keyed db_sha no longer matches the
   * installed catalog. */
  ensureSidecar(catalogId: ModuleId): SidecarHandle {
    const catalog: CatalogHandle = this.openCatalog(catalogId);
    const cached: SidecarHandle | undefined = this.sidecarHandles.get(catalogId);
    if (cached !== undefined && cached.dbSha === catalog.dbSha) {
      return cached;
    }
    if (cached !== undefined) {
      this.sidecarHandles.delete(catalogId);
      cached.db.close();
    }
    const fresh: SidecarHandle = this.rebuildSidecar(catalogId, catalog.dbSha);
    this.sidecarHandles.set(catalogId, fresh);
    return fresh;
  }

  /**
   * Double-buffered sidecar build (§6.5): write a COMPLETE fresh
   * sidecar at a temp path, then rename it over the active path (same
   * directory → same fs → atomic). Any reader still on the previous
   * sidecar keeps the old inode — searches during replacement read the
   * previous buffer and return deterministic results; new opens see the
   * new buffer. If the process dies mid-build, the active sidecar and
   * the catalogs dir are untouched; the temp file is inert garbage.
   */
  private rebuildSidecar(catalogId: ModuleId, dbSha: string): SidecarHandle {
    const finalPath: string = ftsPath(this.dataDir, catalogId);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    const tmpPath: string = `${finalPath}.build-${process.pid}-${Date.now()}`;
    try {
      const build: Database.Database = new Database(tmpPath);
      try {
        buildSidecar(build, catalogId, this.dataDir, dbSha);
      } finally {
        build.close();
      }
      fs.renameSync(tmpPath, finalPath);
    } finally {
      // No-op when the rename moved the temp file; cleans up on failure.
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // best effort
      }
    }
    const db: Database.Database = new Database(finalPath);
    return { db, dbSha: readSidecarSha(db) };
  }

  /** Current sidecar db_sha (`''` when absent) — opens transiently, no
   * caching; used by tests and by `invalidate`. */
  sidecarSha(catalogId: ModuleId): string {
    const cached: SidecarHandle | undefined = this.sidecarHandles.get(catalogId);
    if (cached !== undefined) {
      return cached.dbSha;
    }
    try {
      const db: Database.Database = new Database(ftsPath(this.dataDir, catalogId), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        return readSidecarSha(db);
      } finally {
        db.close();
      }
    } catch {
      return '';
    }
  }

  /** Close every cached handle (shutdown). */
  closeAll(): void {
    for (const handle of this.catalogHandles.values()) {
      handle.db.close();
    }
    this.catalogHandles.clear();
    for (const handle of this.sidecarHandles.values()) {
      handle.db.close();
    }
    this.sidecarHandles.clear();
  }
}

// ── ordered (non-FTS) paging ─────────────────────────────────────────

function orderedPage(db: Database.Database, rows: CatalogRow[], limit: number, offset: number): CatalogPage {
  const hasMore: boolean = rows.length > limit;
  const entries: CatalogEntry[] = (hasMore ? rows.slice(0, limit) : rows).map(toEntry);
  const totalRow: { n: number } | undefined = db
    .prepare(`SELECT COUNT(*) AS n FROM masterlist`)
    .get() as { n: number } | undefined;
  const page: CatalogPage = { entries, total: totalRow === undefined ? entries.length : totalRow.n };
  if (hasMore) {
    return { ...page, nextCursor: encodeOffsetCursor(offset + limit) };
  }
  return page;
}

// ── sidecar schema + build ───────────────────────────────────────────

function buildSidecar(
  db: Database.Database,
  catalogId: ModuleId,
  dataDir: string,
  dbSha: string,
): void {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE entry (
      rowid INTEGER PRIMARY KEY,
      "link" TEXT NOT NULL,
      "title" TEXT,
      "alttitles" TEXT,
      "authors" TEXT,
      "artists" TEXT,
      "genres" TEXT,
      "status" TEXT,
      "summary" TEXT,
      "numchapter" INTEGER,
      "jdn" INTEGER
    );
    CREATE VIRTUAL TABLE search_index USING fts5(
      title, summary, genres, alttitles,
      content='entry',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );
  `);
  const insert: Database.Statement = db.prepare(
    `INSERT INTO entry (rowid, "link", "title", "alttitles", "authors", "artists",
                        "genres", "status", "summary", "numchapter", "jdn")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const index: Database.Statement = db.prepare(
    `INSERT INTO search_index(rowid, title, summary, genres, alttitles)
     VALUES (?, ?, ?, ?, ?)`,
  );
  // Read the catalog through a SEPARATE strictly read-only connection —
  // the sidecar build never opens the catalog writable (§6.4).
  const src: Database.Database = new Database(catalogPath(dataDir, catalogId), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rows: CatalogRow[] = src.prepare(`SELECT ${PAGE_SQL} FROM masterlist`).all() as CatalogRow[];
    db.transaction(() => {
      let rowid: number = 0;
      for (const row of rows) {
        rowid += 1;
        insert.run(
          rowid,
          row.link,
          row.title,
          row.alttitles,
          row.authors,
          row.artists,
          row.genres,
          row.status,
          row.summary,
          row.numchapter,
          row.jdn,
        );
        index.run(rowid, row.title, row.summary, row.genres, row.alttitles);
      }
      db.prepare(`INSERT INTO meta (key, value) VALUES ('db_sha', ?)`).run(dbSha);
      db.prepare(`INSERT INTO meta (key, value) VALUES ('catalog_id', ?)`).run(catalogId);
    })();
  } finally {
    src.close();
  }
}

function readSidecarSha(db: Database.Database): string {
  try {
    const row: { value: string } | undefined = db
      .prepare(`SELECT value FROM meta WHERE key = 'db_sha'`)
      .get() as { value: string } | undefined;
    return row === undefined ? '' : row.value;
  } catch {
    return '';
  }
}

function countMatches(
  db: Database.Database,
  match: string | undefined,
  filters: SearchRowFilters,
): number {
  const rowFilters: { sql: string; params: readonly (string | number)[] } =
    composeRowFilters(filters);
  const withMatch: boolean = match !== undefined;
  try {
    const row: { n: number } | undefined = db
      .prepare(
        `
        SELECT COUNT(*) AS n
        ${withMatch ? 'FROM search_index s JOIN entry e ON e.rowid = s.rowid' : 'FROM entry e'}
        ${withMatch ? 'WHERE search_index MATCH ?' : 'WHERE 1=1'}${rowFilters.sql}`,
      )
      .get(...(withMatch ? [match as string, ...rowFilters.params] : [...rowFilters.params])) as
      | { n: number }
      | undefined;
    return row === undefined ? 0 : row.n;
  } catch {
    return 0;
  }
}

// ── FMD2 Filter-panel row filters (WHERE composition) ───────────────

/** Row filters composed after the FTS MATCH clause (FMD2 parity). */
export interface SearchRowFilters {
  /** Exact `status` column equality (FMD2 stStatus, DBDataProcess:1404). */
  readonly status?: string;
  /** `authors` column LIKE-contains (DBDataProcess:1394). */
  readonly authors?: string;
  /** Each genre must appear in `genres` (LIKE-contains). */
  readonly genres?: readonly string[];
  /** `'all'` (FMD2 rbAll default) ANDs the genre clauses; `'any'` ORs. */
  readonly genresMode: 'all' | 'any';
  /** Only-new window: `jdn > JDN(today) - newDays` (DBDataProcess:1382). */
  readonly newDays?: number;
}

/** JDN of today (UTC) — the only-new window anchor (FMD2 uses local
 * `Now`; UTC is the server-side deterministic default). */
export function jdnToday(): number {
  const now: Date = new Date();
  return dateToJdn({
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
  });
}

/** Escape SQL LIKE wildcards in a user value (`%`/`_` are literal). */
export function escapeLikeValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * Compose the post-MATCH WHERE fragment (each clause starts with its
 * own ` AND`, so callers append it after `WHERE 1=1` / the MATCH).
 *
 * Genres: FMD2 parity is a LIKE-contains per genre joined by OR
 * (`rbAny`/one-of) or AND (`rbAll`/all — the FMD2 default). SQLite
 * LIKE is already case-insensitive for ASCII, matching FMD2's
 * LIKE-based AddSQLSimpleFilter. Note (documented fast-path): SQLite
 * can only use an index over a LIKE when the pattern is a literal
 * PREFIX (`LIKE 'x%'`) — contains-matching (`%x%`) scans; the catalogs
 * are read-only attached files where the FTS sidecar already carries
 * the hot path, so contains-parity is kept and the prefix fast-path
 * is deliberately NOT taken (it would change FMD2 semantics).
 */
export function composeRowFilters(filters: SearchRowFilters): {
  sql: string;
  params: readonly (string | number)[];
} {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (filters.status !== undefined) {
    parts.push(` AND e."status" = ?`);
    params.push(filters.status);
  }
  if (filters.authors !== undefined) {
    parts.push(` AND e."authors" LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLikeValue(filters.authors)}%`);
  }
  const genres: readonly string[] = filters.genres ?? [];
  if (genres.length > 0) {
    const clauses: string[] = genres.map((): string => `e."genres" LIKE ? ESCAPE '\\'`);
    const genreParams: string[] = genres.map((g): string => `%${escapeLikeValue(g)}%`);
    const join: string = filters.genresMode === 'any' ? ' OR ' : ' AND ';
    parts.push(` AND (${clauses.join(join)})`);
    params.push(...genreParams);
  }
  if (filters.newDays !== undefined) {
    parts.push(` AND e."jdn" > ?`);
    params.push(jdnToday() - filters.newDays);
  }
  return { sql: parts.join(''), params };
}

// ── pagination + query plumbing ─────────────────────────────────────

function pageBounds(query: CatalogBrowseQuery): { limit: number; offset: number } {
  const limit: number = Math.min(
    CATALOG_PAGE_MAX,
    Math.max(1, Math.trunc(query.limit ?? CATALOG_PAGE_DEFAULT)),
  );
  const page: number = Math.max(1, Math.trunc(query.page ?? 1));
  return { limit, offset: (page - 1) * limit };
}

/** User query → safe FTS5 MATCH: whitespace tokens ANDed as quoted
 * phrases; a trailing `*` becomes a prefix query. Throws on an empty
 * query (the API layer validates first). */
export function buildMatchQuery(raw: string): string {
  const tokens: string[] = raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new Error('empty search query');
  }
  const parts: string[] = tokens.map((t) => {
    if (t.endsWith('*') && t.length > 1) {
      return `"${escapeFtsPhrase(t.slice(0, -1))}"*`;
    }
    return `"${escapeFtsPhrase(t)}"`;
  });
  return parts.join(' AND ');
}

function escapeFtsPhrase(phrase: string): string {
  return phrase.replaceAll('"', '""');
}

// ── cursor encoding (opaque, query-bound) ───────────────────────────

interface OffsetCursor {
  o: number;
}

/**
 * Search cursor payload — binds the FULL issued filter state (FMD2
 * filter fields + match expression + offset) so a cursor can never be
 * silently re-paged against a different filter combination. `g` is the
 * legacy single-genre FTS phrase filter.
 */
interface SearchCursor {
  q: string;
  o: number;
  g?: string;
  st?: string;
  a?: string;
  gs?: string;
  gm?: 'all' | 'any';
  nd?: number;
}

/** Genres join separator (a char that never occurs in a genre name). */
const CURSOR_GENRE_SEP = '\x1f';

function cursorGenreKey(genres: readonly string[]): string {
  return genres.join(CURSOR_GENRE_SEP);
}

function encodeOffsetCursor(offset: number): string {
  const payload: OffsetCursor = { o: offset };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function encodeSearchCursor(
  match: string,
  offset: number,
  genre: string,
  filters: SearchRowFilters,
): string {
  const payload: SearchCursor = { q: match, o: offset };
  if (genre !== '') {
    payload.g = genre;
  }
  if (filters.status !== undefined) {
    payload.st = filters.status;
  }
  if (filters.authors !== undefined) {
    payload.a = filters.authors;
  }
  const genres: readonly string[] = filters.genres ?? [];
  if (genres.length > 0) {
    payload.gs = cursorGenreKey(genres);
    payload.gm = filters.genresMode;
  }
  if (filters.newDays !== undefined) {
    payload.nd = filters.newDays;
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

interface DecodedSearchCursor {
  limit: number;
  offset: number;
  cursor?: SearchCursor;
}

function decodeSearchCursor(query: CatalogSearchQuery): DecodedSearchCursor {
  const limit: number = Math.min(
    CATALOG_PAGE_MAX,
    Math.max(1, Math.trunc(query.limit ?? CATALOG_PAGE_DEFAULT)),
  );
  if (query.cursor !== undefined && query.cursor !== '') {
    let payload: SearchCursor;
    try {
      payload = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as SearchCursor;
    } catch {
      throw new Error('malformed cursor');
    }
    if (typeof payload.o !== 'number' || payload.o < 0) {
      throw new Error('malformed cursor');
    }
    return { limit, offset: Math.trunc(payload.o), cursor: payload };
  }
  const page: number = Math.max(1, Math.trunc(query.page ?? 1));
  return { limit, offset: (page - 1) * limit };
}

/** A decoded cursor must match the issued match expression, legacy
 * genre filter, and every row filter — else the caller 400s. */
function searchCursorMatches(
  cursor: SearchCursor,
  match: string | undefined,
  genre: string | undefined,
  filters: SearchRowFilters,
): boolean {
  if (cursor.q !== (match ?? '')) {
    return false;
  }
  if ((cursor.g ?? '') !== (genre ?? '')) {
    return false;
  }
  if ((cursor.st ?? '') !== (filters.status ?? '')) {
    return false;
  }
  if ((cursor.a ?? '') !== (filters.authors ?? '')) {
    return false;
  }
  const genres: readonly string[] = filters.genres ?? [];
  if (genres.length > 0) {
    if (cursor.gs !== cursorGenreKey(genres) || (cursor.gm ?? 'all') !== filters.genresMode) {
      return false;
    }
  } else if (cursor.gs !== undefined) {
    return false;
  }
  if ((cursor.nd ?? undefined) !== filters.newDays) {
    return false;
  }
  return true;
}
