import { describe, expect, it } from 'vitest';
import { openSession } from './harness.js';
import { compareOrUpdateGolden } from './golden.js';

/**
 * E2E seed flow 1 — ComicK GetInfo (JSON API): the real module file with
 * the `json(...)` node-tree adapter, node-scoped XPathString, §5.7
 * `require 'utils.json'`, option lookups and the chapter-list pagination
 * loop. Recorded corpus provenance: the comick.cc search-API capture is a
 * parked-domain page (dead site — every oracle result is honestly
 * "empty"), so the flow uses committed synthetic fixtures grounded in the
 * module's own documented API shapes.
 */

const SLUG = 'solo-leveling';
const COMIC_URL = `https://comick.live/comic/${SLUG}`;
const CHAPTER_LIST_URL = `https://comick.live/api/comics/${SLUG}/chapter-list?chapOrder=asc&page=1&lang=en`;

function comicPage(): string {
  const comicData = {
    title: 'Solo Leveling',
    slug: SLUG,
    status: 1,
    demographic_name: 'shounen',
    origination: 'Korean',
    desc: 'Level up.',
    default_thumbnail: 'https://comick.cc/thumbs/solo-leveling.jpg',
    md_titles: [{ title: '나 혼자만 레벨업' }, { title: 'Solamente yo subo de nivel' }],
    authors: [{ name: 'Chugong' }],
    artists: [],
    md_comic_md_genres: [{ md_genres: { name: 'Action' } }, { md_genres: { name: 'Fantasy' } }],
  };
  return [
    '<!DOCTYPE html>',
    '<html><head>',
    `<script id="comic-data">${JSON.stringify(comicData)}</script>`,
    '</head><body></body></html>',
    '',
  ].join('\n');
}

function chapterList(): string {
  return JSON.stringify({
    data: [
      {
        hid: 'a1b2c3',
        chap: '179',
        title: '',
        vol: '',
        lang: 'fr',
        publish_at: '2024-01-01T00:00:00',
        group_name: ['Flame Scans'],
        md_chapters_groups: [{ md_groups: { title: ' Flame Scans ' } }],
      },
      {
        hid: 'd4e5f6',
        chap: '178',
        title: 'The strongest hunter',
        vol: '18',
        lang: 'fr',
        publish_at: '2099-01-01T00:00:00', // future-dated → ignored by the module
        group_name: [],
        md_chapters_groups: [],
      },
    ],
    pagination: { last_page: 1 },
  });
}

describe('seed flow: ComicK GetInfo', () => {
  it('runs the JSON-API GetInfo against recorded fixtures, offline', async () => {
    const session = await openSession({
      moduleFile: 'modules/ComicK.lua',
      responses: [
        { url: COMIC_URL, status: 200, mimeType: 'text/html; charset=utf-8', body: comicPage() },
        {
          url: CHAPTER_LIST_URL,
          status: 200,
          mimeType: 'application/json',
          body: chapterList(),
        },
      ],
    });
    try {
      expect(session.descriptor.id).toBe('214e30f0afec420cafddefe22b4d973c');
      expect(session.descriptor.name).toBe('ComicK');

      const result = session.dispatch('GetInfo', { url: `/comic/${SLUG}` });
      if (result.kind === 'failed') {
        console.log('FAILED:', JSON.stringify(result));
        console.log('LOGS:', session.logger.records.map((r) => `${r.level}:${r.message}`).join(' | ').slice(0, 800));
      }
      expect(result.kind).toBe('code');
      expect(result.kind === 'code' && result.value).toBe(0); // no_error

      const fields = session.runLua(`
        return MANGAINFO.Title .. '|' .. MANGAINFO.AltTitles .. '|' .. MANGAINFO.Authors
          .. '|' .. MANGAINFO.Genres .. '|' .. MANGAINFO.Status .. '|' .. MANGAINFO.CoverLink
      `) as string;
      const [title, altTitles, authors, genres, status, coverLink] = fields.split('|');
      expect(title).toBe('Solo Leveling');
      expect(altTitles).toBe('나 혼자만 레벨업, Solamente yo subo de nivel');
      expect(authors).toBe('Chugong');
      expect(genres).toBe('Action, Fantasy, Shounen, Korean');
      expect(status).toBe('1'); // MangaInfoStatusIfPos('1','1','2','4','3') → ongoing
      expect(coverLink).toBe('https://comick.cc/thumbs/solo-leveling.jpg');

      const chapterCount = session.runLua('return MANGAINFO.ChapterLinks.Count') as number;
      expect(chapterCount).toBe(1); // future-dated chapter 178 ignored
      const links: string[] = [];
      const names: string[] = [];
      for (let i = 0; i < chapterCount; i += 1) {
        links.push(String(session.runLua(`return MANGAINFO.ChapterLinks[${i}]`)));
        names.push(String(session.runLua(`return MANGAINFO.ChapterNames[${i}]`)));
      }
      expect(links).toEqual([`comic/${SLUG}/a1b2c3-chapter-179-en`]);
      expect(names).toEqual(['Ch. 179']);

      compareOrUpdateGolden('comick-getinfo', {
        module: 'ComicK',
        moduleId: session.descriptor.id,
        event: 'GetInfo',
        url: COMIC_URL,
        fixtureProvenance:
          'corpus/fixtures/seed/ComicK/source.json is a parked-domain capture (dead site); flow fixtures are committed synthetic bodies grounded in the module API shapes',
        result,
        mangaInfo: { title, altTitles, authors, genres, status, coverLink },
        chapterLinks: links,
        chapterNames: names,
        httpRequests: session.resolver.requests,
      });
    } finally {
      await session.dispose();
    }
  });
});
