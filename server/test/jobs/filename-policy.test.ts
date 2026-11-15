import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FMD_NORMALIZE_PATHS_ENV,
  FMD_NORMALIZE_PATHS_FLAG,
  applyFileNamePolicy,
  fileNamePolicyMode,
  linuxNormalizeFileName,
  normalizePathsRequested,
  type FileNamePolicyMode,
} from '@fmd/contract';
import { resolveChapterFileName, type ChapterFileNameParts } from '../../src/jobs/library/filenames.js';
import { composeFileName } from '../../src/jobs/download/filenames.js';

/**
 * D5 filename-policy tests (DESIGN.md §14 D5): the SAME fixture sets
 * run through BOTH modes — Windows-desktop parity (default, flags
 * unset: tail truncation over CurrentMaxFileNameLength) and the
 * `FMD_NORMALIZE_PATHS=1` / `--normalize-paths` Linux-normalized opt-out
 * (same resolution + sanitization, control units deleted, NO tail
 * truncation). The committed filename goldens cover parity with the
 * flag unset (unchanged); this file proves the switch at the shared
 * choke point (`applyFileNamePolicy`) and through both resolvers.
 */

interface FilenameCasesFile {
  readonly resolve: readonly {
    readonly name: string;
    readonly parts: Record<string, unknown>;
    readonly expected?: string;
    readonly throws?: boolean;
  }[];
}

const doc = JSON.parse(
  readFileSync(
    join(process.cwd(), 'server/test/jobs/library/fixtures/filename-cases.json'),
    'utf8',
  ),
) as FilenameCasesFile;

const PARITY: FileNamePolicyMode = 'windows-parity';
const NORMALIZE: FileNamePolicyMode = 'linux-normalized';

/** The D5 normalize expectation oracle: same resolution, NO truncation. */
function resolveWithoutMaxLength(parts: ChapterFileNameParts): string {
  const clone = JSON.parse(JSON.stringify(parts)) as Record<string, unknown>;
  delete clone['maxLength'];
  return resolveChapterFileName(clone as ChapterFileNameParts);
}

describe('D5 mode resolution (env + CLI alias)', (): void => {
  it('default (no env, no flag) = windows-parity', (): void => {
    expect(normalizePathsRequested({}, [])).toBe(false);
    expect(fileNamePolicyMode({}, [])).toBe(PARITY);
  });

  it('FMD_NORMALIZE_PATHS=1 enables; every other value keeps parity', (): void => {
    expect(normalizePathsRequested({ [FMD_NORMALIZE_PATHS_ENV]: '1' }, [])).toBe(true);
    expect(fileNamePolicyMode({ [FMD_NORMALIZE_PATHS_ENV]: '1' }, [])).toBe(NORMALIZE);
    for (const off of ['0', '', 'true', 'yes', 'ON', '2']) {
      expect(normalizePathsRequested({ [FMD_NORMALIZE_PATHS_ENV]: off }, [])).toBe(false);
    }
  });

  it('--normalize-paths anywhere on argv enables (CLI alias)', (): void => {
    expect(normalizePathsRequested({}, ['node', 'server', '--normalize-paths'])).toBe(true);
    expect(fileNamePolicyMode({}, ['node', 'server', FMD_NORMALIZE_PATHS_FLAG])).toBe(NORMALIZE);
    expect(normalizePathsRequested({}, ['node', 'server', '--other-flag'])).toBe(false);
    // env beats nothing — either surface enables; both = still normalize.
    expect(fileNamePolicyMode({ [FMD_NORMALIZE_PATHS_ENV]: '0' }, ['--normalize-paths'])).toBe(NORMALIZE);
  });

  it('the choke point resolves the mode from process env when ungiven', (): void => {
    vi.stubEnv(FMD_NORMALIZE_PATHS_ENV, '1');
    // parity would keep the tail ('e-001'); normalize keeps the name whole.
    expect(applyFileNamePolicy('page-001', { maxLength: 5 })).toBe('page-001');
    vi.stubEnv(FMD_NORMALIZE_PATHS_ENV, '0');
    expect(applyFileNamePolicy('page-001', { maxLength: 5 })).toBe('e-001');
  });

  it('the choke point resolves the mode from process argv when ungiven', (): void => {
    const realArgv = process.argv;
    process.argv = ['node', 'fmd-web', FMD_NORMALIZE_PATHS_FLAG];
    try {
      expect(applyFileNamePolicy('page-001', { maxLength: 5 })).toBe('page-001');
    } finally {
      process.argv = realArgv;
    }
  });

  afterEach((): void => {
    vi.unstubAllEnvs();
  });
});

describe('applyFileNamePolicy — the shared choke point (both modes)', (): void => {
  interface PolicyCase {
    readonly name: string;
    readonly input: string;
    readonly maxLength: number;
    readonly parity: string;
    readonly normalize: string;
  }

  // Tail survival = the LAST maxLength units (uDownloadsManager.pas:543-550).
  const cases: readonly PolicyCase[] = [
    { name: 'short name, limit above', input: 'abc', maxLength: 10, parity: 'abc', normalize: 'abc' },
    { name: 'short name, limit 0 = unlimited', input: 'abc', maxLength: 0, parity: 'abc', normalize: 'abc' },
    { name: 'truncation applies in parity', input: 'page-0001-of-0120', maxLength: 10, parity: '01-of-0120', normalize: 'page-0001-of-0120' },
    { name: 'exact length is not truncated', input: '0123456789', maxLength: 10, parity: '0123456789', normalize: '0123456789' },
    { name: 'negative maxLength = no limit', input: 'abcdef', maxLength: -3, parity: 'abcdef', normalize: 'abcdef' },
    { name: 'control units: parity keeps (RemoveSymbols has no sweep), normalize deletes', input: 'a\u0000b\u0001c\u007fd', maxLength: 0, parity: 'a\u0000b\u0001c\u007fd', normalize: 'abcd' },
    { name: 'unicode is untouched in both modes', input: 'タワーロリポップ 01', maxLength: 5, parity: 'ップ 01', normalize: 'タワーロリポップ 01' },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} (max=${String(testCase.maxLength)})`, (): void => {
      expect(applyFileNamePolicy(testCase.input, { mode: PARITY, maxLength: testCase.maxLength })).toBe(testCase.parity);
      expect(applyFileNamePolicy(testCase.input, { mode: NORMALIZE, maxLength: testCase.maxLength })).toBe(testCase.normalize);
    });
  }

  it('explicit mode overrides the env', (): void => {
    vi.stubEnv(FMD_NORMALIZE_PATHS_ENV, '1');
    expect(applyFileNamePolicy('page-001', { mode: PARITY, maxLength: 5 })).toBe('e-001');
    vi.stubEnv(FMD_NORMALIZE_PATHS_ENV, '0');
    expect(applyFileNamePolicy('page-001', { mode: NORMALIZE, maxLength: 5 })).toBe('page-001');
  });

  it('linuxNormalizeFileName deletes exactly C0 + DEL (C1 and above are kept)', (): void => {
    expect(linuxNormalizeFileName('a\u0000b\u001fc\u007fd\u0080e')).toBe('abcd\u0080e');
    expect(linuxNormalizeFileName('a\tb\nc d')).toBe('abc d'); // tab/LF are C0; space (0x20) is not
    expect(linuxNormalizeFileName('a\u00a0b')).toBe('a\u00a0b'); // NBSP is not C0
  });
});

describe('resolveChapterFileName — same fixture set through both modes', (): void => {
  // The COMMITTED golden fixture set (filename-cases.json), first
  // re-verified in explicit parity mode (flag-unset semantics), then run
  // through the Linux-normalized opt-out: identical resolution, the
  // tail truncation dropped, control units stripped (the fixtures hold
  // none, so the oracle is parity-without-maxLength).
  for (const testCase of doc.resolve) {
    const parts = testCase.parts as ChapterFileNameParts;
    if (testCase.throws === true) {
      it(`${testCase.name} — throws in both modes`, (): void => {
        expect(() => resolveChapterFileName({ ...parts, mode: PARITY })).toThrow();
        expect(() => resolveChapterFileName({ ...parts, mode: NORMALIZE })).toThrow();
      });
      continue;
    }
    const expected = testCase.expected ?? '';
    it(`${testCase.name} — parity (explicit) matches the golden`, (): void => {
      expect(resolveChapterFileName({ ...parts, mode: PARITY })).toBe(expected);
    });
    it(`${testCase.name} — normalize: same resolution, never truncated`, (): void => {
      const oracle = linuxNormalizeFileName(resolveWithoutMaxLength(parts));
      expect(resolveChapterFileName({ ...parts, mode: NORMALIZE })).toBe(oracle);
    });
  }

  interface ModeCase {
    readonly name: string;
    readonly parts: ChapterFileNameParts;
    readonly parity: string;
    readonly normalize: string;
  }

  // Hand-written mode rows: literals for BOTH modes, incl. the
  // truncation-only-in-parity rule and the control-unit fall-through.
  const modeCases: readonly ModeCase[] = [
    {
      name: 'parity truncates the SaveImage winner; normalize keeps it whole',
      parts: { saveImageName: 'page-0001-of-0120', maxLength: 10 },
      parity: '01-of-0120',
      normalize: 'page-0001-of-0120',
    },
    {
      name: 'template winner (%FILENAME% empty → literal text): truncation only in parity',
      parts: { template: 'img-%FILENAME%.bin', maxLength: 6 },
      parity: 'g-.bin',
      normalize: 'img-.bin',
    },
    {
      name: 'FileNames winner: truncation only in parity',
      parts: { fileNames: ['chapter-page-0007.png'], fileNamesIndex: 0, maxLength: 8 },
      parity: '0007.png',
      normalize: 'chapter-page-0007.png',
    },
    {
      name: 'interior control units survive parity, deleted by normalize',
      parts: { fileNames: ['a\u0000b\u0001c'], fileNamesIndex: 0, maxLength: 0 },
      parity: 'a\u0000b\u0001c',
      normalize: 'abc',
    },
    {
      name: 'DEL survives parity; a DEL-only candidate normalizes away and falls through',
      parts: { fileNames: ['\u007f'], fileNamesIndex: 0, chapterName: 'Real Name', maxLength: 0 },
      parity: '\u007f',
      normalize: 'Real Name',
    },
    {
      name: 'symbols are deleted identically in both modes',
      parts: { saveImageName: 'a/b:c*?"<>|\t;d;e', maxLength: 0 },
      parity: 'abcde',
      normalize: 'abcde',
    },
    {
      name: 'FPC Trim identical in both modes',
      parts: { chapterName: '  Chapter 1  ', maxLength: 0 },
      parity: 'Chapter 1',
      normalize: 'Chapter 1',
    },
  ];

  for (const testCase of modeCases) {
    it(`${testCase.name}`, (): void => {
      expect(resolveChapterFileName({ ...testCase.parts, mode: PARITY })).toBe(testCase.parity);
      expect(resolveChapterFileName({ ...testCase.parts, mode: NORMALIZE })).toBe(testCase.normalize);
    });
  }

  it('env-resolved default: flag unset = parity, FMD_NORMALIZE_PATHS=1 = normalize', (): void => {
    const parts: ChapterFileNameParts = { saveImageName: 'page-0001-of-0120', maxLength: 10 };
    vi.stubEnv(FMD_NORMALIZE_PATHS_ENV, '0');
    expect(resolveChapterFileName(parts)).toBe('01-of-0120');
    vi.stubEnv(FMD_NORMALIZE_PATHS_ENV, '1');
    expect(resolveChapterFileName(parts)).toBe('page-0001-of-0120');
  });
});

describe('composeFileName — same fixture set through both modes', (): void => {
  interface ComposeCase {
    readonly name: string;
    readonly workId: number;
    readonly fileNames: readonly string[];
    readonly pageCount: number;
    readonly template: string;
    readonly maxLength: number;
    readonly parity: string;
    readonly normalize: string;
  }

  const cases: readonly ComposeCase[] = [
    {
      name: 'FileNames winner, no limit',
      workId: 0, fileNames: ['a.jpg', 'b.jpg'], pageCount: 2, template: '', maxLength: 0,
      parity: 'a.jpg', normalize: 'a.jpg',
    },
    {
      name: 'index fallback through template, parity truncates',
      workId: 0, fileNames: [], pageCount: 5, template: 'page-%FILENAME%', maxLength: 5,
      parity: 'e-001', normalize: 'page-001',
    },
    {
      name: 'module name longer than the limit',
      workId: 0, fileNames: ['very-long-module-file-name.jpg'], pageCount: 1, template: '%FILENAME%', maxLength: 8,
      parity: 'name.jpg', normalize: 'very-long-module-file-name.jpg',
    },
    {
      name: 'limit 0 = unlimited in both modes',
      workId: 2, fileNames: [], pageCount: 5, template: '', maxLength: 0,
      parity: '003', normalize: '003',
    },
    {
      name: 'control units deleted only by normalize',
      workId: 0, fileNames: ['a\u0001b'], pageCount: 1, template: '', maxLength: 0,
      parity: 'a\u0001b', normalize: 'ab',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} (max=${String(testCase.maxLength)})`, (): void => {
      const run = (mode: FileNamePolicyMode): string =>
        composeFileName(testCase.workId, testCase.fileNames, testCase.pageCount, testCase.template, testCase.maxLength, mode);
      expect(run(PARITY)).toBe(testCase.parity);
      expect(run(NORMALIZE)).toBe(testCase.normalize);
    });
  }

  it('env-resolved default: flag unset keeps parity truncation, =1 drops it', (): void => {
    vi.stubEnv(FMD_NORMALIZE_PATHS_ENV, '0');
    expect(composeFileName(0, [], 5, 'page-%FILENAME%', 5)).toBe('e-001');
    vi.stubEnv(FMD_NORMALIZE_PATHS_ENV, '1');
    expect(composeFileName(0, [], 5, 'page-%FILENAME%', 5)).toBe('page-001');
  });
});
