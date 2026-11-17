/**
 * [parity-sweep] M5/M6/M8/M10/M13 — the settings-honored server
 * behaviors, unit level: the output-rename options (unicode
 * replacement, remove-manga-name), digit padding, the pipeline
 * default-timeout seam, and the structured-log diagnostics filter.
 */
import { describe, expect, it } from 'vitest';
import { applyOutputRenameOptions } from '../../src/jobs/library/filenames.js';
import { indexFileName } from '../../src/jobs/download/filenames.js';
import { defaultRequestTimeoutMs, HttpPipeline, setDefaultRequestTimeoutMs } from '../../src/engine/shims/http-pipeline.js';
import { StructuredLogger } from '../../src/observability/structured-log.js';

describe('applyOutputRenameOptions (FMD2 lfm:3947/4183/4014)', () => {
  const off = { unicodeReplacement: false, unicodeReplacementChar: '_', removeMangaName: false };

  it('all options OFF is the identity (byte-parity default)', () => {
    expect(applyOutputRenameOptions('Ch.1 名探偵', off, 'One Piece')).toBe('Ch.1 名探偵');
  });

  it('removeMangaName strips a leading manga-title prefix + separators', () => {
    const on = { ...off, removeMangaName: true };
    expect(applyOutputRenameOptions('One Piece Chapter 1044', on, 'One Piece')).toBe('Chapter 1044');
    expect(applyOutputRenameOptions('one piece - Chapter 5', on, 'One Piece')).toBe('Chapter 5');
  });

  it('removeMangaName leaves names that do not start with the title', () => {
    const on = { ...off, removeMangaName: true };
    expect(applyOutputRenameOptions('Chapter 1044', on, 'One Piece')).toBe('Chapter 1044');
    expect(applyOutputRenameOptions('Piece of One', on, 'One Piece')).toBe('Piece of One');
  });

  it('unicodeReplacement replaces non-ASCII runs with the char (runs collapse)', () => {
    const on = { unicodeReplacement: true, unicodeReplacementChar: '_', removeMangaName: false };
    expect(applyOutputRenameOptions('Ch.1 名探偵コナン end', on, 'X')).toBe('Ch.1 _ end');
    expect(applyOutputRenameOptions(' purely ascii ', on, 'X')).toBe(' purely ascii ');
  });

  it('unicodeReplacement honors a custom replacement char', () => {
    const on = { unicodeReplacement: true, unicodeReplacementChar: 'x', removeMangaName: false };
    expect(applyOutputRenameOptions('aéb', on, 'X')).toBe('axb');
  });

  it('both options compose (strip prefix, then replace unicode)', () => {
    const on = { unicodeReplacement: true, unicodeReplacementChar: '_', removeMangaName: true };
    // '名作 第10話' − '名作' prefix − separator → '第10話' → '_10_'.
    expect(applyOutputRenameOptions('名作 第10話', on, '名作')).toBe('_10_');
  });
});

describe('indexFileName digit padding (FMD2 lfm:4026)', () => {
  it('default width stays 3 (server truth)', () => {
    expect(indexFileName(0)).toBe('001');
    expect(indexFileName(9)).toBe('010');
  });

  it('a settings width sets the MINIMUM pad (ordering still grows)', () => {
    expect(indexFileName(0, 5)).toBe('00001');
    expect(indexFileName(123_456, 2)).toBe('123457');
  });

  it('padding 0 keeps the default 3', () => {
    expect(indexFileName(4, 0)).toBe('005');
  });
});

describe('HTTP pipeline default timeout seam ([parity-sweep] M10)', () => {
  it('setDefaultRequestTimeoutMs seeds NEW pipelines (module override still wins)', () => {
    const before: number = defaultRequestTimeoutMs();
    try {
      setDefaultRequestTimeoutMs(42_000);
      expect(defaultRequestTimeoutMs()).toBe(42_000);
      const pipeline = new HttpPipeline({} as never);
      expect(pipeline.timeout).toBe(42_000);
      pipeline.timeout = 1_000; // module code override
      expect(pipeline.timeout).toBe(1_000);
    } finally {
      setDefaultRequestTimeoutMs(before);
    }
  });
});

describe('StructuredLogger diagnostics filter ([parity-sweep] M13)', () => {
  const collect = (): { lines: string[]; logger: StructuredLogger } => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ sink: (line): void => { lines.push(line); } });
    return { lines, logger };
  };

  it('default passes everything (pre-settings behavior)', () => {
    const { lines, logger } = collect();
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines).toHaveLength(4);
  });

  it('logEnabled=false drops EVERYTHING', () => {
    const { lines, logger } = collect();
    logger.applyDiagnostics({ logEnabled: false, logLevel: 'debug' });
    logger.error('e');
    expect(lines).toHaveLength(0);
  });

  it('minimum level filters below-threshold records (applied LIVE)', () => {
    const { lines, logger } = collect();
    logger.applyDiagnostics({ logEnabled: true, logLevel: 'warn' });
    logger.debug('d');
    logger.info('i');
    expect(lines).toHaveLength(0);
    logger.warn('w');
    logger.error('e');
    expect(lines).toHaveLength(2);
    // Live flip back
    logger.applyDiagnostics({ logEnabled: true, logLevel: 'debug' });
    logger.info('i2');
    expect(lines).toHaveLength(3);
  });

  it('module-scoped writers honor the same filter', () => {
    const { lines, logger } = collect();
    logger.applyDiagnostics({ logEnabled: true, logLevel: 'error' });
    logger.forModule('a'.repeat(32)).info('hidden');
    logger.forModule('a'.repeat(32)).error('shown');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"shown"');
  });
});
