/**
 * Docs link integrity (tsk-fierce-beacon-speeds): the user guide is a
 * first-class surface — in-app empty states link into it by anchor, and
 * the guide links to sibling docs and its own sections. This gate keeps
 * every one of those references honest at CI time:
 *
 *   1. every in-app `docs/USER-GUIDE.md#<anchor>` href (web/src/**)
 *      must resolve to a heading anchor in docs/USER-GUIDE.md;
 *   2. every guide-internal `](#<anchor>)` link must resolve the same
 *      way;
 *   3. every relative file link in the guide (`](runbook.md)` etc.)
 *      must point at an existing file next to the guide;
 *   4. the four empty-state surfaces the charter names (browse picker,
 *      favorites, downloads, library) each carry a guide link at all —
 *      the href cannot silently disappear in a refactor.
 *
 * Anchors are GitHub-flavored slugs (lowercase, punctuation stripped,
 * spaces to hyphens, duplicate suffixes -1/-2/…), matching how the
 * rendered markdown host resolves them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webRoot: string = fileURLToPath(new URL('..', import.meta.url));
const repoRoot: string = join(webRoot, '..');
const guidePath: string = join(repoRoot, 'docs', 'USER-GUIDE.md');
const srcRoot: string = join(webRoot, 'src');

/** GitHub-style heading slug (unicode-aware enough for our ASCII heads). */
function githubSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/** All heading anchors in a markdown document, duplicate-suffixed. */
function markdownAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of markdown.split('\n')) {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    const slug = githubSlug(match[2] ?? '');
    if (slug === '') {
      continue;
    }
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${String(count)}`);
  }
  return anchors;
}

const guide: string = readFileSync(guidePath, 'utf8');
const guideAnchors: Set<string> = markdownAnchors(guide);

/** Recursively collect source files that may carry hrefs. */
function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
    } else if (/\.(tsx?|css)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles: string[] = collectFiles(srcRoot);

describe('in-app user-guide links', (): void => {
  const hrefPattern = /href="docs\/USER-GUIDE\.md#([\w-]+)"/g;

  it('the app links into the guide (at least the four empty states)', (): void => {
    const all: string[] = [];
    for (const file of sourceFiles) {
      for (const match of readFileSync(file, 'utf8').matchAll(hrefPattern)) {
        all.push(`${file}:${match[1]}`);
      }
    }
    expect(all.length).toBeGreaterThanOrEqual(4);
  });

  it('every in-app docs/USER-GUIDE.md#anchor href resolves to a guide heading', (): void => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const match of readFileSync(file, 'utf8').matchAll(hrefPattern)) {
        const anchor = match[1] ?? '';
        if (!guideAnchors.has(anchor)) {
          offenders.push(`${file} → #${anchor}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the four empty-state surfaces carry their guide links', (): void => {
    const required: readonly { readonly file: string; readonly anchor: string }[] = [
      { file: join(srcRoot, 'pages', 'SearchHomePage.tsx'), anchor: 'finding-manga' },
      { file: join(srcRoot, 'pages', 'FavoritesPage.tsx'), anchor: 'favorites-lifecycle' },
      { file: join(srcRoot, 'pages', 'DownloadsPage.tsx'), anchor: 'downloading' },
      { file: join(srcRoot, 'pages', 'LibraryPage.tsx'), anchor: 'library' },
    ];
    for (const { file, anchor } of required) {
      const hrefs = [...readFileSync(file, 'utf8').matchAll(hrefPattern)].map(
        (match): string => match[1] ?? '',
      );
      expect(hrefs, `${file} must link to #${anchor}`).toContain(anchor);
    }
  });
});

describe('guide-internal links', (): void => {
  it('every ](#anchor) self-link resolves to a guide heading', (): void => {
    const offenders: string[] = [];
    for (const match of guide.matchAll(/\]\(#([\w-]+)\)/g)) {
      const anchor = match[1] ?? '';
      if (!guideAnchors.has(anchor)) {
        offenders.push(`#${anchor}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every relative file link resolves to a real docs file', (): void => {
    const offenders: string[] = [];
    for (const match of guide.matchAll(/\]\(([^)#\s]+)(?:#[\w-]+)?\)/g)) {
      const target = match[1] ?? '';
      if (/^[a-z]+:\/\//.test(target)) {
        continue; // absolute URLs are out of scope (offline CI)
      }
      const resolved = normalize(join(dirname(guidePath), target));
      try {
        statSync(resolved);
      } catch {
        offenders.push(target);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guide covers the nine charter workflow areas', (): void => {
    const required: readonly string[] = [
      'getting-started',
      'finding-manga',
      'manga-and-chapters',
      'downloading',
      'library',
      'favorites-lifecycle',
      'accounts',
      'settings',
      'troubleshooting',
    ];
    for (const anchor of required) {
      expect(guideAnchors.has(anchor), `missing workflow section #${anchor}`).toBe(true);
    }
  });
});
