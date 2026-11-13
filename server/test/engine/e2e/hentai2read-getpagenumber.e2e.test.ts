import { describe, expect, it } from 'vitest';
import { openSession, readSeedFixture } from './harness.js';
import { compareOrUpdateGolden } from './golden.js';

/**
 * E2E seed flow 3 — Hentai2Read GetPageNumber (§5.6 list-fill overload +
 * `json(...)` inside): real module file, recorded fixture page, golden
 * TASK.PageLinks. Chapter page is a synthetic sibling of the recorded
 * browse page (same `script[data-page="app"]` JSON-app shape the oracle
 * triples prove; images array instead of books).
 */

const CHAPTER_URL = 'https://hentai2read.com/chapter-page-1/';
const PAGE_LINKS = [
  'https://images.hentai2read.com/a/1.jpg',
  'https://images.hentai2read.com/a/2.jpg',
  'https://images.hentai2read.com/a/3.jpg',
];

function chapterPage(): string {
  const app = {
    props: { images: PAGE_LINKS },
  };
  return [
    '<!DOCTYPE html>',
    '<html><head>',
    `<script data-page="app">${JSON.stringify(app)}</script>`,
    '</head><body><div id="content"></div></body></html>',
    '',
  ].join('\n');
}

describe('seed flow: Hentai2Read GetPageNumber', () => {
  it('fills TASK.PageLinks via the list-fill json() overload, offline', async () => {
    const session = await openSession({
      moduleFile: 'modules/Hentai2Read.lua',
      responses: [
        {
          url: CHAPTER_URL,
          status: 200,
          mimeType: 'text/html; charset=utf-8',
          body: chapterPage(),
        },
      ],
    });
    try {
      // module identity from the real Init pass
      expect(session.descriptor.id).toBe('053da85062184626a0a1ff6d57c3c955');
      expect(session.descriptor.name).toBe('Hentai2Read');

      const result = session.dispatch('GetPageNumber', { url: '/chapter-page-1/' });
      expect(result.kind).toBe('boolean');
      expect(result.kind === 'boolean' && result.value).toBe(true);

      const count = session.runLua('return TASK.PageLinks.Count') as number;
      const links: string[] = [];
      for (let i = 0; i < count; i += 1) {
        links.push(String(session.runLua(`return TASK.PageLinks[${i}]`)));
      }
      expect(links).toEqual(PAGE_LINKS);

      // recorded Document stream: the response body landed in HTTP.Document
      const docSize = session.runLua('return HTTP.Document.Size') as number;
      expect(docSize).toBeGreaterThan(0);

      // PAGENUMBER read-back (§5.2: the ONLY read-back global) against the
      // RECORDED fixture: json(//script[@data-page="app"]).props.books.lastPage
      // — the oracle triple 17#1 captured "1752" on exactly this document
      const recorded = readSeedFixture('Hentai2Read', 'source.html');
      session.resolver.add({
        url: 'https://hentai2read.com/browse/newest/page-1',
        status: 200,
        mimeType: 'text/html; charset=utf-8',
        body: recorded,
      });
      const dir = session.dispatch('GetDirectoryPageNumber');
      expect(dir.kind).toBe('code');
      expect(dir.kind === 'code' && dir.value).toBe(0);
      const readBack = dir.kind === 'code' ? dir.readBack['PAGENUMBER'] : undefined;
      expect(readBack).toBe(1752);

      compareOrUpdateGolden('hentai2read-getpagenumber', {
        module: 'Hentai2Read',
        moduleId: session.descriptor.id,
        event: 'GetPageNumber',
        url: CHAPTER_URL,
        fixtureProvenance: 'corpus/fixtures/seed/Hentai2Read/source.html (browse page; chapter page is a synthetic sibling)',
        result,
        taskPageLinks: links,
        directoryPageNumber: { result: dir, pagenumberReadBack: readBack, fixture: 'corpus/fixtures/seed/Hentai2Read/source.html (RECORDED)' },
        httpRequests: session.resolver.requests,
      });
      // the recorded seed fixture parses and satisfies its captured truth
      expect(readSeedFixture('Hentai2Read', 'manifest.json')).toContain('Hentai2Read');
    } finally {
      await session.dispose();
    }
  });
});
