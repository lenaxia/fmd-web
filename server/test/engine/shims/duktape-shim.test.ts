import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DuktapeHeap, duktapeGlobal, makeDuktapeShim } from '../../../src/engine/shims/duktape-shim.js';
import { createMemoryLogger } from '../../../src/engine/lua/logger.js';

/**
 * Duktape shim v0 (§5.7): ExecJS via node:vm with the 5 s timeout, the
 * Duktape.enc/dec polyfill, and the JS-side CommonJS require jailed to
 * the synced lua/ tree (acceptance criterion: the Madara decryption
 * snippet — `require("utils/crypto-js.min.js")` — executes inside
 * node:vm; templates/Madara.lua:178-179, Duktape.pas:88-90).
 */

const MADARA_SNIPPET = (chapterData: string, nonce: string): string => `
${chapterData}

${nonce}

var CryptoJS = require("utils/crypto-js.min.js");
var CryptoJSAesJson = require("utils/cryptojs-aes-format.js");
JSON.parse(CryptoJS.AES.decrypt(chapter_data, wpmangaprotectornonce, { format: CryptoJSAesJson }).toString(CryptoJS.enc.Utf8));
`;

const CIPHERTEXT = readFileSync('/workspace/fmd-web/server/test/engine/shims/fixtures/madara-chapter-data.txt', 'utf8').trim();

describe('Duktape shim v0', () => {
  it('ExecJS evaluates plain JS and stringifies the completion value', () => {
    const shim = makeDuktapeShim({ luaRoot: '/workspace/FMD2/lua', logger: null, moduleId: 'test' });
    const ExecJS = shim.ExecJS as (js: unknown) => string | undefined;
    // duk_peval semantics: no top-level `return`; the completion value
    // stringifies ('undefined' results read back as '')
    expect(ExecJS('0')).toBe('0');
    expect(ExecJS('1 + 2')).toBe('3');
    expect(ExecJS('return 0')).toBeUndefined();
  });

  it('ExecJS returns nil (undefined) on JS errors — never throws (LuaDuktape.pas:18-24)', () => {
    const logger = createMemoryLogger();
    const shim = makeDuktapeShim({ luaRoot: '/workspace/FMD2/lua', logger, moduleId: 'test' });
    const ExecJS = shim.ExecJS as (js: unknown) => string | undefined;
    expect(ExecJS('throw "boom"')).toBeUndefined();
    expect(ExecJS('this is not javascript')).toBeUndefined();
    expect(ExecJS('while(true){}')).toBeUndefined(); // 5 s timeout → nil
    expect(logger.records.some((r) => r.level === 'error' && r.message.includes('Duktape.ExecJS()'))).toBe(true);
  });

  it('JS require resolves utils/crypto-js.min.js from the pinned lua tree inside node:vm', () => {
    const runtime = new DuktapeHeap({ luaRoot: '/workspace/FMD2/lua', logger: null, moduleId: 'test' });
    const crypto = runtime.require('utils/crypto-js.min.js') as { AES: { decrypt(...args: never[]): unknown } };
    expect(typeof crypto).toBe('object');
    expect(typeof crypto.AES).toBe('object');
  });

  it('executes the Madara decryption snippet (Duktape require + CryptoJS AES)', () => {
    const shim = makeDuktapeShim({ luaRoot: '/workspace/FMD2/lua', logger: null, moduleId: 'test' });
    const ExecJS = shim.ExecJS as (js: unknown) => string | undefined;
    const script = MADARA_SNIPPET(
      `var chapter_data = '${CIPHERTEXT}';`,
      `var wpmangaprotectornonce = 'wpmangaprotector-nonce-v0';`,
    );
    const result = ExecJS(script);
    expect(result).toBeDefined();
    // duk_safe_to_string parity (Duktape.pas:93-94): the array completion
    // value renders comma-joined, no brackets, no quotes. NOTE: upstream
    // templates/Madara.lua:184-186 gsubs brackets and gmatches QUOTED
    // entries — against this ToString form it extracts nothing, which is
    // the desktop FMD2 behavior for that flow as well (the v0 shim's
    // JSON rendering made OUR output differ from the desktop oracle).
    expect(String(result)).toBe([
      'https://images.wuxiaworld.site/file/manga-sites/an-manga/ch-001/001.jpg',
      'https://images.wuxiaworld.site/file/manga-sites/an-manga/ch-001/002.jpg',
      'https://i1.wp.com/images.wuxiaworld.site/file/manga-sites/an-manga/ch-001/003.jpg',
    ].join(','));
  });

  it('array completion values stringify comma-joined (FanFox newImgs → CommaText)', () => {
    const shim = makeDuktapeShim({ luaRoot: '/workspace/FMD2/lua', logger: null, moduleId: 'test' });
    const ExecJS = shim.ExecJS as (js: unknown) => string | undefined;
    // the FanFox GetPageNumber shape: 'var $=...,newImgs,guidkey;' +
    // script + ';newImgs||guidkey;' — newImgs is an ARRAY on live pages
    // and PageLinks.CommaText consumes the comma-joined ToString form
    expect(ExecJS('var newImgs=["//h/a1.jpg","//h/a2.jpg","//h/a3.jpg"]; newImgs||"";'))
      .toBe('//h/a1.jpg,//h/a2.jpg,//h/a3.jpg');
    expect(ExecJS('({a:1})')).toBe('[object Object]');
  });

  it('require is cached per runtime (module identity stable) and jailed', () => {
    const runtime = new DuktapeHeap({ luaRoot: '/workspace/FMD2/lua', logger: null, moduleId: 'test' });
    const a = runtime.require('utils/cryptojs-aes-format.js');
    const b = runtime.require('utils/cryptojs-aes-format.js');
    expect(a).toBe(b);
    // jail: escaping the lua tree is refused → ExecJS maps it to nil
    const shim = makeDuktapeShim({ luaRoot: '/workspace/FMD2/lua', logger: null, moduleId: 'test' });
    const ExecJS = shim.ExecJS as (js: unknown) => string | undefined;
    expect(ExecJS('require("../package.json")')).toBeUndefined();
    expect(ExecJS('require("node:fs")')).toBeUndefined();
  });

  it('Duktape.enc/dec polyfill round-trips hex and base64', () => {
    const enc = duktapeGlobal['enc'] as (mode: string, data: unknown) => string;
    const dec = duktapeGlobal['dec'] as (mode: string, data: unknown) => string;
    expect(enc('hex', 'fmd')).toBe(Buffer.from('fmd', 'utf8').toString('hex'));
    expect(dec('hex', enc('hex', 'fmd'))).toBe('fmd');
    expect(enc('base64', 'fmd')).toBe(Buffer.from('fmd', 'utf8').toString('base64'));
    expect(dec('base64', enc('base64', 'fmd'))).toBe('fmd');
  });

  it('JS print routes to the host log (Duktape.pas:90)', () => {
    const logger = createMemoryLogger();
    const shim = makeDuktapeShim({ luaRoot: '/workspace/FMD2/lua', logger, moduleId: 'mod-1' });
    (shim.ExecJS as (js: unknown) => string | undefined)('print("hello from JS")');
    const printed = logger.records.find((r) => r.level === 'log' && r.message.includes('hello from JS'));
    expect(printed?.moduleId).toBe('mod-1');
  });
});
