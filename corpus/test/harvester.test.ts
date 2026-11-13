import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  harvestLuaSource,
  harvestLuaFile,
  harvestFmd2Tree,
  countExpressions,
  type HarvestedExpression,
} from '../harvester/harvest.js';

const edgeCasesPath = fileURLToPath(
  new URL('../fixtures/lua/EdgeCases.lua', import.meta.url),
);

/** FMD2 Lua repo checkout, sibling of fmd-web (env-overridable). */
function fmd2LuaDir(): string {
  return process.env['FMD2_LUA_DIR'] ?? fileURLToPath(
    new URL('../../../FMD2/lua', import.meta.url),
  );
}

function byId(exprs: readonly HarvestedExpression[]): Map<string, HarvestedExpression> {
  return new Map(exprs.map((e): [string, HarvestedExpression] => [e.id, e]));
}

describe('harvester — Lua string lexing (quoting edge cases)', (): void => {
  it('extracts plain double- and single-quoted XPath literals', (): void => {
    const exprs = harvestLuaSource(
      `local a = x.XPathString('//div[@class="title"]')\n` +
      `local b = x.XPath("//meta[@name='description']/@content")\n`,
    );
    expect(exprs).toHaveLength(2);
    expect(exprs[0]?.expression).toBe('//div[@class="title"]');
    expect(exprs[0]?.method).toBe('XPathString');
    expect(exprs[0]?.output).toBe('scalar');
    expect(exprs[1]?.expression).toBe("//meta[@name='description']/@content");
    expect(exprs[1]?.output).toBe('all');
  });

  it('decodes escaped quotes and decimal escapes', (): void => {
    const exprs = harvestLuaSource(
      `local c = x.XPathString('//a[@title="it\\'s here"]')\n` +
      `local o = x.XPathString('//div[@id="\\65rticle"]')\n`,
    );
    expect(exprs[0]?.expression).toBe(`//a[@title="it's here"]`);
    expect(exprs[1]?.expression).toBe('//div[@id="Article"]');
  });

  it('handles long-bracket strings at several levels, including ]] inside', (): void => {
    const exprs = harvestLuaSource(
      // Level-0 long brackets end at the first ]], so plain [[...]] cannot
      // embed a closing ]] — that is what [==[...]==] is for.
      `local d = x.XPath([[//div[@data-x='y' and @id="main"]/h1]])\n` +
      `local e = x.XPathString([==[//div[@data-json='{"k": [1]}']/span]==])\n`,
    );
    expect(exprs).toHaveLength(2);
    expect(exprs[0]?.expression).toBe(`//div[@data-x='y' and @id="main"]/h1`);
    expect(exprs[1]?.expression).toBe(`//div[@data-json='{"k": [1]}']/span`);
  });

  it('handles multi-line long-bracket expressions with line attribution', (): void => {
    const src =
      `local m = x.XPath([[\n` +
      `//div[contains(@class, "post-title")]\n` +
      `/*[self::h3]\n` +
      `/a\n` +
      `]])\n`;
    const exprs = harvestLuaSource(src);
    expect(exprs).toHaveLength(1);
    expect(exprs[0]?.expression).toBe(
      `\n//div[contains(@class, "post-title")]\n/*[self::h3]\n/a\n`,
    );
    expect(exprs[0]?.line).toBe(1);
  });

  it('ignores commented-out calls and calls inside plain strings', (): void => {
    const src =
      `-- local h = x.XPathString('//comment-fake')\n` +
      `local pattern = "x.XPathString('//string-fake')"\n` +
      `--[[ block comment x.XPath('//block-fake') ]]\n` +
      `local ok = x.XPathString('//real-one')\n`;
    const exprs = harvestLuaSource(src);
    expect(exprs).toHaveLength(1);
    expect(exprs[0]?.expression).toBe('//real-one');
  });

  it('treats literal concatenation as static and var concatenation as dynamic', (): void => {
    const exprs = harvestLuaSource(
      `local g = x.XPathString('//div' .. '[@class="row"]' .. '/a')\n` +
      `local f = x.XPathString('(//li)[' .. IDX .. ']/a')\n`,
    );
    expect(exprs).toHaveLength(2);
    expect(exprs[0]?.dynamic).toBe(false);
    expect(exprs[0]?.expression).toBe('//div[@class="row"]/a');
    expect(exprs[1]?.dynamic).toBe(true);
    // Literal fragments preserved with a placeholder where the var sits.
    expect(exprs[1]?.expression).toBe('(//li)[{…}]/a');
  });

  it('skips calls whose first argument has no string literal', (): void => {
    const exprs = harvestLuaSource(`local p = x.XPathString(someVariable)\n`);
    expect(exprs).toHaveLength(0);
  });

  it('classifies json()/css() dialects and count/list outputs', (): void => {
    const exprs = harvestLuaSource(
      `local j = x.XPathString('json(*).data[?(@.type=="main")]')\n` +
      `local k = x.XPathString('css(.manga-title)')\n` +
      `local n = x.XPathCount('//div[@class="chapter"]')\n` +
      `x.XPathStringAll('//ul/a', TASK.PageLinks)\n` +
      `x.XPathHREFAll('//div/a', LINKS, NAMES)\n` +
      `x.XPathHREFTitleAll('//div/a', LINKS, NAMES)\n`,
    );
    expect(exprs.map((e) => e.language)).toEqual([
      'json', 'css', 'xpath', 'xpath', 'xpath', 'xpath',
    ]);
    expect(exprs.map((e) => e.output)).toEqual([
      'scalar', 'scalar', 'count', 'list', 'list', 'list',
    ]);
  });

  it('only harvests the registered TXQuery method surface', (): void => {
    const src =
      `q:Add('//not-a-query')\n` +
      `local r = string.format('//also-not')\n` +
      `local s = x.NotARealQuery('//nope')\n` +
      `local t = x.XPathString('//yes')\n`;
    const exprs = harvestLuaSource(src);
    expect(exprs).toHaveLength(1);
    expect(exprs[0]?.expression).toBe('//yes');
  });

  it('assigns stable occurrence-scoped ids', (): void => {
    const src = `x.XPathString('//a') x.XPathString('//a')\nx.XPathString('//b')\n`;
    const exprs = harvestLuaSource(src);
    expect(exprs.map((e) => e.id)).toEqual(['1#1', '1#2', '2#1']);
  });
});

describe('harvester — hand-written fixture module', (): void => {
  const mod = harvestLuaFile(edgeCasesPath);

  it('harvests exactly the real call sites (17 extracts, fakes and var-only excluded)', (): void => {
    // 20 query-shaped calls exist; the commented/string fakes and the
    // variable-only argument extract nothing.
    expect(mod.module).toBe('EdgeCases');
    expect(mod.expressions).toHaveLength(17);
  });

  it('covers every quoting edge case with the exact expected text', (): void => {
    const map = byId(mod.expressions);
    const texts = [...map.values()].map((e) => e.expression);
    expect(texts).toContain(`//a[@title="it's here"]/@href`);
    expect(texts).toContain(`//div[@data-x='y' and @id="main"]/h1`);
    expect(texts).toContain(`//div[@data-json='{"k": [1]}']/span`);
  });
});

describe('harvester — FMD2 corpus-wide sanity bound (§13.1)', (): void => {
  it('extracts ≥1500 expressions across modules/ + templates/', (): void => {
    const luaDir = fmd2LuaDir();
    let readable = true;
    try {
      readFileSync(luaDir + '/modules/AsuraScans.lua', 'utf8');
    } catch {
      readable = false;
    }
    if (!readable) {
      throw new Error(
        `FMD2 lua tree not found at ${luaDir} (set FMD2_LUA_DIR) — corpus sanity test requires it`,
      );
    }
    const { modules, templates } = harvestFmd2Tree(luaDir);
    const total = countExpressions(modules) + countExpressions(templates);
    // DESIGN's analysis figure is ~1947; the sanity bound is deliberately
    // lower (1500) so benign lexer refactors do not flip CI.
    expect(total).toBeGreaterThanOrEqual(1500);
    expect(modules.length).toBeGreaterThanOrEqual(400);
    // Named special-case modules must all yield expressions.
    const names = new Set(modules.map((m) => m.module));
    names.add('Madara'); // template half
    for (const must of [
      'ComicK', 'MangaPlus', 'EHentai', 'Tapas',
      'Hentai2Read', 'MangaDex', '18Comic', 'MangaGo', 'AsuraScans',
    ]) {
      expect(names.has(must), `missing special-case module ${must}`).toBe(true);
    }
    expect(templates.map((t) => t.module)).toContain('Madara');
  });
});
