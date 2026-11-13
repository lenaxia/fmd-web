import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLuaHost } from '../../../src/engine/lua/host.js';
import { createMemoryLogger } from '../../../src/engine/lua/logger.js';
import type { WasmoonLuaEngine } from '../../../src/engine/lua/engine.js';
import type { WasmoonLuaHost } from '../../../src/engine/lua/host.js';
import { MANGAINFO_STRING_FIELDS } from '../../../src/engine/lua/mangainfo.js';

/**
 * MANGAINFO facade contract tests (§5.5, LuaMangaInfo.pas:23-34): the exact
 * field set, case-sensitive keys, unknown keys silently no-op — the facade
 * contract row (contract.json facades[MangaInfo]).
 */

describe('MANGAINFO facade contract (LuaMangaInfo.pas:23-34)', () => {
  let host: WasmoonLuaHost;
  let engine: WasmoonLuaEngine;

  beforeEach(async () => {
    host = createLuaHost(createMemoryLogger());
    engine = await host.createEngine();
    await host.chunkCache.get('mi.lua', 'MI_PLACEHOLDER = true');
    await engine.loadModule('mi.lua');
  });

  afterEach(async () => {
    await engine.dispose();
    await host.dispose();
  });

  async function bindMangaInfo(): Promise<{
    fields: Record<string, string>;
    links: string[];
    names: string[];
  }> {
    const bridge = engine.debugBridge;
    const { makeMangaInfoSpec } = await import('../../../src/engine/lua/mangainfo.js');
    const handle = makeMangaInfoSpec(bridge);
    bridge.create('MANGAINFO', handle.spec);
    return {
      fields: handle.fields,
      get links() {
        return handle.chapterLinks.list.snapshot();
      },
      get names() {
        return handle.chapterNames.list.snapshot();
      },
    };
  }

  it('exposes exactly the 10 string fields + ChapterLinks/ChapterNames', async () => {
    expect(MANGAINFO_STRING_FIELDS).toEqual([
      'URL',
      'Title',
      'AltTitles',
      'Link',
      'CoverLink',
      'Authors',
      'Artists',
      'Genres',
      'Status',
      'Summary',
    ]);
    await bindMangaInfo();
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    // all string fields readable (default '') and writable
    for (const f of MANGAINFO_STRING_FIELDS) {
      expect(run(`return MANGAINFO.${f}`)).toBe('');
      run(`MANGAINFO.${f} = 'v-${f}'`);
      expect(run(`return MANGAINFO.${f}`)).toBe(`v-${f}`);
    }
    // TStrings sub-objects reachable and functional (luaClassAddObject rows)
    run(`MANGAINFO.ChapterLinks.Add('/c/1') MANGAINFO.ChapterNames.Add('Ch 1')`);
    expect(run(`return MANGAINFO.ChapterLinks[0]`)).toBe('/c/1');
    expect(run(`return MANGAINFO.ChapterNames[0]`)).toBe('Ch 1');
    expect(run(`return MANGAINFO.ChapterLinks.Count`)).toBe(1);
  });

  it('unknown-property typos silently no-op on get AND set (contract row)', async () => {
    const handle = await bindMangaInfo();
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    // the MANGAINFO.Artist typo (OrckuMangas.lua:91) — reads nil, write dropped
    run(`MANGAINFO.Artist = 'typo must no-op'`);
    expect(run(`return MANGAINFO.Artist`)).toBeNull();
    expect(Object.values(handle.fields).every((v) => v === '' || v.startsWith('v-'))).toBe(true);
    expect(handle.fields['Artist']).toBeUndefined();
    // other typo shapes: wrong case, numeric key, totally bogus
    expect(run(`return MANGAINFO.title`)).toBeNull(); // lowercase ≠ Title
    expect(run(`return MANGAINFO.Chapterlink`)).toBeNull();
    run(`MANGAINFO.title = 'x' MANGAINFO.Chapterlink = 'y'`);
    expect(handle.fields['Title']).not.toBe('x');
    expect(run(`return MANGAINFO.title`)).toBeNull();
  });

  it('keys are CASE-SENSITIVE: Title and title are distinct keys', async () => {
    const handle = await bindMangaInfo();
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    run(`MANGAINFO.Title = 'Real' MANGAINFO.title = 'Lower'`);
    expect(run(`return MANGAINFO.Title`)).toBe('Real');
    expect(run(`return MANGAINFO.title`)).toBeNull();
    expect(handle.fields['Title']).toBe('Real');
    // ChapterLinks vs chapterlinks
    run(`MANGAINFO.chapterlinks = 'x'`);
    expect(run(`return MANGAINFO.chapterlinks`)).toBeNull();
    expect(run(`return MANGAINFO.ChapterLinks ~= nil`)).toBe(true);
  });

  it('host seam: harvested backing matches what Lua wrote (§5.8 input shape)', async () => {
    const handle = await bindMangaInfo();
    const run = (code: string): unknown => engine.innerEngine.doStringSync(code);
    run(`
      MANGAINFO.Title = ' Example  '
      MANGAINFO.URL = 'https://s.example/m'
      MANGAINFO.ChapterLinks.Add('/1')
      MANGAINFO.ChapterLinks.Add('/2')
      MANGAINFO.ChapterNames.Add('One')
    `);
    expect(handle.fields['Title']).toBe(' Example  ');
    expect(handle.fields['URL']).toBe('https://s.example/m');
    expect(handle.links).toEqual(['/1', '/2']);
    expect(handle.names).toEqual(['One']);
  });
});
