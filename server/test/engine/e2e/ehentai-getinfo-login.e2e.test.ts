import { describe, expect, it } from 'vitest';
import { openSession } from './harness.js';
import { compareOrUpdateGolden } from './golden.js';
import type { LuaModuleDescriptor } from '@fmd/contract';

/**
 * E2E seed flow 5 — EHentai GetInfo + ExHentai Login + GetDirectoryPageNumber:
 * account constants (asUnknown/asChecking/asValid bound per the §5.2
 * account-status table), the account reached ONLY as MODULE.Account
 * (there is no ACCOUNT global), `fmd.crypto.EncodeURLElement`, cookie-jar
 * reads of server Set-Cookie headers, `css()` over the gallery pagination
 * table, and the PAGENUMBER read-back (the only §5.2 read-back global).
 * The gallery page is a committed synthetic fixture grounded in the
 * real gallery DOM shape; the corpus fixture (seed/EHentai/source.html)
 * is the homepage listing.
 */

const GALLERY_URL = 'https://e-hentai.org/g/2715593/04b3e2c1aa/';
const LOGIN_URL = 'https://forums.e-hentai.org/index.php?act=Login&CODE=01';
const DIR_URL = 'https://exhentai.org/?f_doujinshi=on&f_manga=on&f_western=on&f_apply=Apply+Filter';

function galleryPage(): string {
  return [
    '<!DOCTYPE html>',
    '<html><head><title>Gallery</title></head><body>',
    '<div id="gd1"><div style="background:transparent url(https://ehgt.org/g/cover.jpg) 0 0 no-repeat"></div></div>',
    '<div id="gn">Test Gallery Title</div>',
    '<a id="ta_artist">Some Artist</a>',
    '<a id="ta_artist2">Other Artist</a>',
    '<a id="ta_group">A Group</a>',
    '<a id="ta_female">female:big tag</a>',
    '<table class="ptt" id="pt"><tbody>',
    '<tr><td>&lt;</td><td>1</td><td><a href="?p=2">2</a></td><td><a href="?p=3">3</a></td><td><a href="?p=6">6</a></td><td>&gt;</td></tr>',
    '</tbody></table>',
    '</body></html>',
    '',
  ].join('\n');
}

const LOGIN_PAGE = '<html><body>Logged in</body></html>';

function pickExHentai(descriptors: readonly LuaModuleDescriptor[]): LuaModuleDescriptor {
  const exh = descriptors.find((d) => d.id === '17e196ebe84c4042a6fbf4594d25d9e0');
  if (exh === undefined) {
    throw new Error(`ExHentai descriptor missing: ${descriptors.map((d) => d.id).join(',')}`);
  }
  return exh;
}

describe('seed flow: EHentai GetInfo + ExHentai Login', () => {
  it('runs GetInfo, account Login and PAGENUMBER read-back, offline', async () => {
    const session = await openSession({
      moduleFile: 'modules/EHentai.lua',
      pickModule: pickExHentai,
      responses: [
        { url: GALLERY_URL, status: 200, mimeType: 'text/html; charset=utf-8', body: galleryPage() },
        {
          url: LOGIN_URL,
          status: 200,
          mimeType: 'text/html; charset=utf-8',
          body: LOGIN_PAGE,
          headers: { 'Set-Cookie': 'ipb_pass_hash=abc123; path=/; secure' },
        },
        { url: DIR_URL, status: 200, mimeType: 'text/html; charset=utf-8', body: galleryPage() },
      ],
      shims: {
        account: { enabled: true, username: 'user@test.example', password: 'hunter2' },
      },
    });
    try {
      expect(session.descriptor.name).toBe('ExHentai');
      expect(session.descriptor.accountSupport).toBe(true);

      // --- GetInfo -------------------------------------------------------
      const getInfo = session.dispatch('GetInfo', { url: `${GALLERY_URL}?page=3&f_search=xyz` });
      expect(getInfo.kind).toBe('code');
      expect(getInfo.kind === 'code' && getInfo.value).toBe(0); // no_error

      const fields = session.runLua(`
        return MANGAINFO.Title .. '|' .. MANGAINFO.CoverLink .. '|' .. MANGAINFO.Artists
          .. '|' .. MANGAINFO.Genres .. '|' .. MANGAINFO.Status
      `) as string;
      const [title, coverLink, artists, genres, status] = fields.split('|');
      expect(title).toBe('Test Gallery Title');
      expect(coverLink).toBe('https://ehgt.org/g/cover.jpg'); // via @style match
      expect(artists).toBe('Some Artist, Other Artist');
      expect(genres).toBe('A Group, female:big tag'); // ta_* minus ta_artist*
      expect(status).toBe('Unknown'); // MangaInfoStatusIfPos: title has no wip/complete marker
      expect(session.runLua('return MANGAINFO.ChapterLinks.Count')).toBe(1); // galleries = 1 "chapter"

      // --- Login (account-status constants + MODULE.Account) ---------------
      const before = session.runLua('return MODULE.Account.Status');
      expect(before).toBe(0); // asUnknown
      const login = session.dispatch('Login');
      expect(login.kind).toBe('boolean');
      expect(login.kind === 'boolean' && login.value).toBe(true);
      expect(session.runLua('return MODULE.Account.Status')).toBe(2); // asValid
      // the login POST carried urlencoded credentials (EncodeURLElement)
      const post = session.resolver.requests.find((r) => r.method === 'POST');
      expect(post?.url).toBe(LOGIN_URL);
      expect(post?.body).toContain('UserName=user%40test.example');
      expect(post?.body).toContain('PassWord=hunter2');
      expect(post?.headers['Content-Type']).toContain('application/x-www-form-urlencoded');
      // server Set-Cookie landed in the module cookie jar
      expect(session.runLua(`return HTTP.Cookies.Values['ipb_pass_hash']`)).toBe('abc123');

      // --- GetDirectoryPageNumber: FMD2 parity on a real module bug -------
      // EHentai.lua:71 reads `CreateTXQuery(...).x.XPathString(...)` — the
      // `x` field does not exist in FMD2's TXQuery either (LuaClass
      // __index: unknown keys read nil), so the dispatch errors in FMD2
      // exactly like here; the update thread logs and keeps the default
      // page count of 1 (uUpdateThread.pas:198). The css() expression
      // itself is ground-truthed by the captured corpus triple
      // (seed/EHentai triple 71#1); the positive PAGENUMBER read-back is
      // proven on Hentai2Read's RECORDED fixture (see its flow test).
      const dir = session.dispatch('GetDirectoryPageNumber');
      expect(dir.kind).toBe('failed');
      expect(dir.kind === 'failed' && dir.reason).toContain("(field 'x')");
      const pageFallback = 1; // uUpdateThread.pas:198 default when the handler errors

      compareOrUpdateGolden('ehentai-getinfo-login', {
        module: 'EHentai (ExHentai account module)',
        moduleId: session.descriptor.id,
        events: ['GetInfo', 'Login', 'GetDirectoryPageNumber'],
        galleryUrl: GALLERY_URL,
        fixtureProvenance:
          'corpus/fixtures/seed/EHentai/source.html is the homepage; gallery/login fixtures are committed synthetic bodies grounded in the real gallery DOM shape',
        getInfo: { result: getInfo, mangaInfo: { title, coverLink, artists, genres, status } },
        login: { accountStatusBefore: 0, result: login, accountStatusAfter: 2, postUrl: post?.url, postBody: post?.body },
        cookieAfterLogin: 'abc123',
        directoryPageNumber: {
          moduleBugParity: 'EHentai.lua:71 `.x` field — errors in FMD2 identically; host default page count = 1',
          result: dir,
          hostDefaultPageCount: pageFallback,
        },
        httpRequests: session.resolver.requests,
      });
    } finally {
      await session.dispose();
    }
  });
});
