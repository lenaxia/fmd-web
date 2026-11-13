import { describe, expect, it } from 'vitest';
import { openSession } from './harness.js';
import { compareOrUpdateGolden } from './golden.js';

/**
 * E2E seed flow 2 — AsuraScans GetInfo (JSON API): `json(*).series`
 * context nodes, `?*` map iteration inside string-join, upper-case/lower-case
 * string functions, a nested CreateTXQuery(string) reparse for the
 * summary, and the premium-chapter filter `[not(is_premium)]`. The
 * recorded corpus fixture (seed/AsuraScans/source.html) is the site
 * homepage; the API bodies below are committed synthetic fixtures
 * grounded in the module's documented API shapes.
 */

const SERIES = '/solo-leveling';
const SERIES_URL = `https://api.asurascans.com/api/series${SERIES}`;
const CHAPTERS_URL = `${SERIES_URL}/chapters`;

function seriesBody(): string {
  return JSON.stringify({
    series: {
      title: 'Solo Leveling',
      alt_titles: ['나 혼자만 레벨업'],
      cover: 'https://api.asurascans.com/cover/sl.jpg',
      author: 'Chugong',
      artist: 'D-U',
      genres: [{ name: 'Action' }, { name: 'Fantasy' }],
      type: 'MANHWA',
      status: 'ongoing',
      description: 'E-Rank hunter.\nLevels up.',
    },
  });
}

function chaptersBody(): string {
  return JSON.stringify({
    data: [
      { number: '179', title: '', is_premium: false },
      { number: '178', title: 'Shadow army', is_premium: true },
      { number: '177', title: 'Double dungeon', is_premium: false },
    ],
  });
}

describe('seed flow: AsuraScans GetInfo', () => {
  it('runs the JSON-API GetInfo against recorded fixtures, offline', async () => {
    const session = await openSession({
      moduleFile: 'modules/AsuraScans.lua',
      responses: [
        { url: SERIES_URL, status: 200, mimeType: 'application/json', body: seriesBody() },
        { url: CHAPTERS_URL, status: 200, mimeType: 'application/json', body: chaptersBody() },
      ],
    });
    try {
      expect(session.descriptor.id).toBe('7103ae6839ea46ec80cdfc2c4b37c803');
      expect(session.descriptor.name).toBe('Asura Scans');

      const result = session.dispatch('GetInfo', { url: SERIES });
      expect(result.kind).toBe('code');
      expect(result.kind === 'code' && result.value).toBe(0); // no_error

      const fields = session.runLua(`
        return MANGAINFO.Title .. '|' .. MANGAINFO.AltTitles .. '|' .. MANGAINFO.CoverLink
          .. '|' .. MANGAINFO.Authors .. '|' .. MANGAINFO.Artists .. '|' .. MANGAINFO.Genres
          .. '|' .. MANGAINFO.Status .. '|' .. MANGAINFO.Summary
      `) as string;
      const [title, altTitles, coverLink, authors, artists, genres, status, summary] = fields.split('|');
      expect(title).toBe('Solo Leveling');
      expect(altTitles).toBe('나 혼자만 레벨업');
      expect(coverLink).toBe('https://api.asurascans.com/cover/sl.jpg');
      expect(authors).toBe('Chugong');
      expect(artists).toBe('D-U');
      expect(genres).toBe('Action, Fantasy, Manhwa'); // upper-case(substring) → 'Manhwa'
      expect(status).toBe('1'); // ongoing
      // string-join(//text(), "\r\n") over the single text node — the
      // \r\n split behavior of InternetTools' repairing parser is a
      // documented COMPAT.md gap (linkedom keeps one text node)
      expect(summary).toBe('E-Rank hunter.\nLevels up.');

      const chapterCount = session.runLua('return MANGAINFO.ChapterLinks.Count') as number;
      expect(chapterCount).toBe(2); // premium chapter 178 filtered out
      const links: string[] = [];
      for (let i = 0; i < chapterCount; i += 1) {
        links.push(String(session.runLua(`return MANGAINFO.ChapterLinks[${i}]`)));
      }
      // modules Add ascending then Reverse() → newest first
      expect(links).toEqual(['solo-leveling/chapters/177', 'solo-leveling/chapters/179']);

      compareOrUpdateGolden('asurascans-getinfo', {
        module: 'AsuraScans',
        moduleId: session.descriptor.id,
        event: 'GetInfo',
        url: SERIES_URL,
        fixtureProvenance:
          'corpus/fixtures/seed/AsuraScans/source.html is the homepage; flow fixtures are committed synthetic bodies grounded in the module API shapes',
        result,
        mangaInfo: { title, altTitles, coverLink, authors, artists, genres, status, summary },
        chapterLinks: links,
        httpRequests: session.resolver.requests,
      });
    } finally {
      await session.dispose();
    }
  });
});
