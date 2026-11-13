import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openSession } from './harness.js';
import { compareOrUpdateGolden } from './golden.js';

/**
 * E2E seed flow 4 — Madara template GetPageNumber through a real site
 * module (BrainRotComics, `Template.GetPageNumber()` →
 * templates/Madara.lua:151-193): the list-fill XPath strategies miss on
 * the chapter page, so the flow falls through to the
 * chapter-protector-data path — `require 'fmd.duktape'.ExecJS(...)` with
 * JS-side `require("utils/crypto-js.min.js")` (Duktape heap, jailed lua
 * tree) — then TASK.PageLinks + the i%d.wp.com/ cleaning loop, plus the
 * TASK.PageNumber / WORKID binding semantics (§5.2 GetPageNumber /
 * BeforeDownloadImage rows). The chapter page is a committed synthetic
 * fixture; the AES ciphertext was produced ONCE with the pinned
 * crypto-js and committed (decryption is deterministic).
 */

const CHAPTER_URL = 'https://brainrotcomics.com/series/test/chapter-1';

function chapterPage(): string {
  const ciphertext = readFileSync(`${import.meta.dirname}/fixtures/madara-chapter-data.txt`, 'utf8').trim();
  // A protector script exactly like the real wpmangaprotector pages
  return [
    '<!DOCTYPE html>',
    '<html><head><title>Chapter 1</title></head><body>',
    `<script id="chapter-protector-data">var chapter_data = '${ciphertext}';var wpmangaprotectornonce = 'wpmangaprotector-nonce-v0';</script>`,
    '<div class="reading-content"></div>',
    '</body></html>',
    '',
  ].join('\n');
}

const EXPECTED_LINKS = [
  'https://images.wuxiaworld.site/file/manga-sites/an-manga/ch-001/001.jpg',
  'https://images.wuxiaworld.site/file/manga-sites/an-manga/ch-001/002.jpg',
  // i1.wp.com/ prefix stripped by the template's cleaning loop
  'https://images.wuxiaworld.site/file/manga-sites/an-manga/ch-001/003.jpg',
];

describe('seed flow: Madara template GetPageNumber (BrainRotComics)', () => {
  it('decrypts chapter_data via Duktape JS require and fills TASK.PageLinks', async () => {
    const session = await openSession({
      moduleFile: 'modules/BrainRotComics.lua',
      responses: [
        {
          url: `${CHAPTER_URL}?style=list`,
          status: 200,
          mimeType: 'text/html; charset=utf-8',
          body: chapterPage(),
        },
      ],
    });
    try {
      expect(session.descriptor.id).toBe('9300f8755204497f998fdb1d831e8b49');
      expect(session.descriptor.name).toBe('BrainRotComics');

      const result = session.dispatch('GetPageNumber', { url: CHAPTER_URL });
      expect(result.kind).toBe('boolean');
      expect(result.kind === 'boolean' && result.value).toBe(true);

      const count = session.runLua('return TASK.PageLinks.Count') as number;
      const links: string[] = [];
      for (let i = 0; i < count; i += 1) {
        links.push(String(session.runLua(`return TASK.PageLinks[${i}]`)));
      }
      expect(links).toEqual(EXPECTED_LINKS);

      // TASK.PageNumber is a read-write int field (contract.json taskFields)
      session.runLua('TASK.PageNumber = 2');
      expect(session.runLua('return TASK.PageNumber')).toBe(2);

      // WORKID binding semantics (§5.2): BeforeDownloadImage/GetImageURL/
      // DownloadImage are the WORKID-bound rows; BrainRotComics binds no
      // handler for them → the host guard raises EventNotBoundError (the
      // FMD2 update thread only dispatches Assigned(handlers))
      let notBound: unknown;
      try {
        session.dispatch('BeforeDownloadImage', { url: EXPECTED_LINKS[0] ?? '', workId: 7 });
      } catch (error) {
        notBound = (error as Error).message;
      }
      expect(notBound).toContain('BeforeDownloadImage');
      expect(notBound).toContain('does not bind a handler');

      compareOrUpdateGolden('madara-template-getpagenumber', {
        module: 'BrainRotComics (templates.Madara)',
        moduleId: session.descriptor.id,
        event: 'GetPageNumber',
        url: `${CHAPTER_URL}?style=list`,
        fixtureProvenance:
          'synthetic chapter page; ciphertext committed from a one-time encrypt with the pinned utils/crypto-js.min.js',
        duktapePath: 'chapter-protector-data → fmd.duktape.ExecJS → require utils/crypto-js.min.js + utils/cryptojs-aes-format.js',
        result,
        taskPageLinks: links,
        taskPageNumberReadWrite: 2,
        workidBinding: {
          beforeDownloadImage: 'MODULE/TASK/HTTP/WORKID/URL per contract.json; module binds no handler → EventNotBoundError',
          error: notBound,
        },
        httpRequests: session.resolver.requests,
      });
    } finally {
      await session.dispose();
    }
  });
});
