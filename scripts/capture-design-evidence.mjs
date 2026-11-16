/**
 * Design-system evidence capture (tsk-fuzzy-titanium-folds): screenshots
 * the six pages through the same fixture mock API the e2e smoke suite
 * uses, in BOTH themes, for the before/after record in
 * docs/evidence-design-system.md.
 *
 *   node scripts/capture-design-evidence.mjs <outdir> [baseUrl]
 *   # e.g. with `npx vite` (web/) already running:
 *   node scripts/capture-design-evidence.mjs docs/evidence-design-system-assets/after
 *
 * The "before" set (docs/evidence-design-system-assets/before/) was
 * captured with the same script from the pre-retrofit UI (2026-11-16,
 * commit d76dcfb era styles.css) — rerunning against a checkout of that
 * commit reproduces it byte-for-byte in intent (same routes, fixtures,
 * viewport).
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'docs/evidence-design-system-assets/after';
const BASE = process.argv[3] ?? 'http://localhost:5173';
mkdirSync(OUT, { recursive: true });

const CATALOG_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const MODULE_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

const entries = [1, 2].map((n) => ({
  link: `/manga/${n === 1 ? 'alpha' : 'beta'}`,
  title: n === 1 ? 'Alpha Quest' : 'Beta Trails',
  alttitles: '',
  authors: n === 1 ? 'Author A' : 'Author B',
  artists: '',
  genres: 'Action',
  status: 'Ongoing',
  summary: '',
  numChapter: 10 + n,
  jdn: n,
}));
const module_ = {
  id: MODULE_ID, name: 'FixtureSite', rootURL: 'https://fixtures.example',
  category: 'Fixtures', accountSupport: true, file: 'modules/FixtureSite.lua',
  enabled: true, proxy: null,
  options: [
    { name: 'Auto-skip pages', kind: 'checkbox', defaultValue: false },
    { name: 'Quality', kind: 'combobox', defaultValue: 1, items: ['low', 'medium', 'high'] },
  ],
  capabilities: {
    requires_subprocess: false, requires_browser: true, bypass_python_gated: false,
    requires_imagepuzzle: false, requires_mangafoxwatermark: false, events: [],
    known_broken_flags: ['cloudflare-loop'], live_scrape_fallback: false,
  },
};
const info = {
  title: 'Alpha Quest', altTitles: 'Alpha Quest (Alt)', authors: 'Author A', artists: 'Artist B',
  genres: 'Action, Adventure', status: 'Ongoing', summary: 'The alpha fixture manga.',
  coverLink: '', url: 'https://fixtures.example/manga/alpha', link: '/manga/alpha',
  chapterLinks: ['/manga/alpha/ch-1', '/manga/alpha/ch-2'],
  chapterNames: ['Chapter 1: The Beginning', 'Chapter 2: The Middle'], numChapter: 2,
};
const job = {
  id: 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', type: 'download', moduleId: MODULE_ID,
  payload: { mangaTitle: 'Alpha Quest', chapterName: 'Chapter 1: The Beginning' },
  state: 'running', priority: 0, createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z',
};
const favorite = {
  id: 'f'.repeat(32) + 'https://fixtures.example/manga/alpha', url: 'https://fixtures.example/manga/alpha',
  moduleId: MODULE_ID, title: 'Alpha Quest', status: 'Ongoing', currentChapter: 12,
  newChapterCount: 3, autoDownload: true, lastCheck: '2026-01-01T00:00:00Z', lastUpdated: null,
};
const libraryFile = {
  id: 'l1', manga: 'Alpha Quest', fileName: 'Chapter 1 The Beginning.zip', bytes: 3_421_997, createdAt: '2026-01-01T00:00:00Z',
};

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const API = (s) => new RegExp(`^https?://[^/]+/api/${s}`);

async function mock(page) {
  await page.route(API(''), (r) => r.fulfill(json({ error: { code: 'not_found', message: 'x' } }, 404)));
  await page.route(API('readyz'), (r) => r.fulfill(json({ ready: true, reason: 'ready' })));
  await page.route(API('modules'), (r) => r.fulfill(json({ modules: [module_], count: 1 })));
  await page.route(API('catalog/[^/]+/latest'), (r) => r.fulfill(json({ entries, total: 2 })));
  await page.route(API('info'), (r) => r.fulfill(json(info)));
  await page.route(API('jobs\\?'), (r) => r.fulfill(json({ jobs: [job] })));
  await page.route(API('favorites'), (r) => r.fulfill(json({ favorites: [favorite] })));
  await page.route(API('library'), (r) => r.fulfill(json({ files: [libraryFile], total: 1 })));
  await page.route(API('settings'), (r) => r.fulfill(json({ proxy: { type: '', host: '', port: '', user: '', pass: '' }, browser: { enabled: false } })));
  await page.routeWebSocket(/^ws:\/\/[^/]+\/ws$/, (ws) => { ws.onMessage(() => {}); });
}

const pages = [
  ['browse', `/#/browse?catalog=${CATALOG_ID}`],
  ['manga', `/#/manga?catalog=${CATALOG_ID}&module=${MODULE_ID}&url=${encodeURIComponent('https://fixtures.example/manga/alpha')}&title=${encodeURIComponent('Alpha Quest')}`],
  ['downloads', '/#/downloads'],
  ['favorites', '/#/favorites'],
  ['library', '/#/library'],
  ['settings', '/#/settings'],
];

const browser = await chromium.launch();
for (const theme of ['dark', 'light']) {
  for (const [name, hash] of pages) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript((t) => {
      try { window.localStorage.setItem('fmd-web-theme', t); } catch { /* best-effort */ }
    }, theme);
    await mock(page);
    await page.goto(`${BASE}${hash}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${name}-${theme}.png`, fullPage: true });
    await page.close();
    console.log(`captured ${name}-${theme}`);
  }
}
await browser.close();
