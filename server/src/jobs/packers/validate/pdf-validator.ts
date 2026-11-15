import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/**
 * PDF validator (§13 packer outputs): parses the classic xref/trailer
 * layout the incremental writer emits, walks Root → Pages → Kids, and
 * verifies every page's /Contents and /XObject image objects exist and
 * carry the expected markers — all via bounded positional reads, so it
 * never materializes the (possibly huge) PDF.
 */

export interface PdfPageCheck {
  readonly objectId: number;
  readonly contentsObjectId: number;
  readonly imageObjectId: number;
  readonly hasPageType: boolean;
}

export interface PdfValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly pageCount: number;
  readonly declaredCount: number;
  readonly trailerSize: number;
  readonly pages: PdfPageCheck[];
}

/** Read window per object (Kids arrays of 1000+ pages need room). */
const OBJECT_WINDOW_BYTES = 512 * 1024;
const TAIL_BYTES = 2048;
const FIRST_WINDOW_BYTES = 4096;

async function readSpan(fh: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

async function fileSize(fh: FileHandle): Promise<number> {
  return (await fh.stat()).size;
}

function extractDict(body: string): string {
  const start = body.indexOf('<<');
  if (start < 0) {
    return '';
  }
  let depth = 0;
  let i = start;
  while (i < body.length - 1) {
    if (body.startsWith('<<', i)) {
      depth += 1;
      i += 2;
    } else if (body.startsWith('>>', i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) {
        return body.slice(start, i);
      }
    } else {
      i += 1;
    }
  }
  return body.slice(start);
}

/** extractDict that reports incompleteness instead of best-effort text. */
function tryExtractDict(body: string): string | undefined {
  const start = body.indexOf('<<');
  if (start < 0) {
    return '';
  }
  let depth = 0;
  let i = start;
  while (i < body.length - 1) {
    if (body.startsWith('<<', i)) {
      depth += 1;
      i += 2;
    } else if (body.startsWith('>>', i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) {
        return body.slice(start, i);
      }
    } else {
      i += 1;
    }
  }
  return undefined;
}

/**
 * The object's `<< ... >>` dictionary via bounded positional reads:
 * windows grow only while the dict stays unbalanced, so stream bodies
 * (hundreds of KiB of image data) are never pulled through the
 * validator — the dict closes before the `stream` keyword.
 */
async function readObjectDict(fh: FileHandle, offset: number): Promise<string> {
  const size = await fileSize(fh);
  let window = FIRST_WINDOW_BYTES;
  for (;;) {
    const span = Math.min(window, size - offset);
    if (span <= 0) {
      return '';
    }
    const text = (await readSpan(fh, offset, span)).toString('latin1');
    const endIndex = text.indexOf('endobj');
    const body = endIndex === -1 ? text : text.slice(0, endIndex);
    const dict = tryExtractDict(body);
    if (dict !== undefined) {
      return dict;
    }
    if (endIndex !== -1 || span >= OBJECT_WINDOW_BYTES) {
      return extractDict(body);
    }
    window = Math.min(window * 4, OBJECT_WINDOW_BYTES);
  }
}

function refValue(dict: string, key: string): number | undefined {
  const match = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return match === null ? undefined : Number.parseInt(match[1] ?? '', 10);
}

function numberValue(dict: string, key: string): number | undefined {
  const match = new RegExp(`/${key}\\s+(-?\\d+)`).exec(dict);
  return match === null ? undefined : Number.parseInt(match[1] ?? '', 10);
}

interface XrefTable {
  readonly offsets: Map<number, number>;
  readonly trailerSize: number;
  readonly rootId: number;
}

async function parseXref(fh: FileHandle): Promise<XrefTable> {
  const size = await fileSize(fh);
  const tailBase = Math.max(0, size - TAIL_BYTES);
  const tail = await readSpan(fh, tailBase, size - tailBase);
  const tailText = tail.toString('latin1');
  const startxrefMatch = /startxref\s+(\d+)\s+%%EOF/.exec(tailText);
  if (startxrefMatch === null) {
    throw new Error('startxref/%%EOF marker not found');
  }
  const xrefOffset = Number.parseInt(startxrefMatch[1] ?? '', 10);
  const header = await readSpan(fh, xrefOffset, 64);
  const headerText = header.toString('latin1');
  if (!/^xref\r?\n/.test(headerText)) {
    throw new Error(`xref table missing at offset ${xrefOffset}`);
  }
  const subsectionMatch = /^xref\r?\n(\d+)\s+(\d+)\r?\n/.exec(headerText);
  if (subsectionMatch === null) {
    throw new Error('xref subsection header malformed');
  }
  const firstObject = Number.parseInt(subsectionMatch[1] ?? '', 10);
  const entryCount = Number.parseInt(subsectionMatch[2] ?? '', 10);
  const tableBase = xrefOffset + subsectionMatch[0].length;
  const table = await readSpan(fh, tableBase, entryCount * 20);
  if (table.length < entryCount * 20) {
    throw new Error('xref table truncated');
  }
  const offsets = new Map<number, number>();
  for (let i = 0; i < entryCount; i += 1) {
    const entry = table.subarray(i * 20, (i + 1) * 20).toString('latin1');
    // 20-byte entry: 10-digit offset, space, 5-digit gen, space,
    // in-use flag at byte 17, 2-byte EOL — check the flag byte itself.
    if (entry.slice(17, 18) === 'n') {
      offsets.set(firstObject + i, Number.parseInt(entry.slice(0, 10), 10));
    }
  }
  const trailerText = (await readSpan(fh, tableBase + entryCount * 20, 512)).toString('latin1');
  const trailerDict = extractDict(trailerText.slice(trailerText.indexOf('trailer') + 7));
  const trailerSize = numberValue(trailerDict, 'Size') ?? 0;
  const rootId = refValue(trailerDict, 'Root');
  if (rootId === undefined) {
    throw new Error('trailer has no /Root reference');
  }
  return { offsets, trailerSize, rootId };
}

async function objectHeaderMatches(fh: FileHandle, id: number, offset: number): Promise<boolean> {
  const head = await readSpan(fh, offset, 32);
  return head.toString('latin1').startsWith(`${id} 0 obj`);
}

/**
 * Validate one PDF file; `expectedPageCount` asserts the parsed page
 * count (the acceptance-criteria "page count matches" test).
 */
export async function validatePdf(
  filePath: string,
  expectedPageCount?: number,
): Promise<PdfValidationResult> {
  const errors: string[] = [];
  const pages: PdfPageCheck[] = [];
  const fh = await open(filePath, 'r');
  try {
    // Header probe.
    const head = await readSpan(fh, 0, 8);
    if (!head.toString('latin1').startsWith('%PDF-')) {
      errors.push('file does not start with %PDF-');
      return { ok: false, errors, pageCount: 0, declaredCount: 0, trailerSize: 0, pages };
    }
    const xref = await parseXref(fh);
    const catalogOffset = xref.offsets.get(xref.rootId);
    if (catalogOffset === undefined || !(await objectHeaderMatches(fh, xref.rootId, catalogOffset))) {
      errors.push(`catalog object ${xref.rootId} missing from xref`);
      return {
        ok: false,
        errors,
        pageCount: 0,
        declaredCount: 0,
        trailerSize: xref.trailerSize,
        pages,
      };
    }
    const catalogDict = await readObjectDict(fh, catalogOffset);
    const pagesId = refValue(catalogDict, 'Pages');
    if (pagesId === undefined) {
      errors.push('catalog has no /Pages reference');
      return {
        ok: false,
        errors,
        pageCount: 0,
        declaredCount: 0,
        trailerSize: xref.trailerSize,
        pages,
      };
    }
    const pagesOffset = xref.offsets.get(pagesId);
    if (pagesOffset === undefined || !(await objectHeaderMatches(fh, pagesId, pagesOffset))) {
      errors.push(`pages object ${pagesId} missing from xref`);
      return {
        ok: false,
        errors,
        pageCount: 0,
        declaredCount: 0,
        trailerSize: xref.trailerSize,
        pages,
      };
    }
    const pagesDict = await readObjectDict(fh, pagesOffset);
    const declaredCount = numberValue(pagesDict, 'Count') ?? -1;
    if (declaredCount < 0) {
      errors.push('pages object has no /Count');
    }
    const kidsMatch = /\/Kids\s*\[([^\]]*)\]/.exec(pagesDict);
    const kidIds: number[] = [];
    if (kidsMatch !== null) {
      const refs = kidsMatch[1]?.matchAll(/(\d+)\s+\d+\s+R/g) ?? [];
      for (const ref of refs) {
        kidIds.push(Number.parseInt(ref[1] ?? '', 10));
      }
    } else {
      errors.push('pages object has no /Kids array');
    }
    if (declaredCount !== kidIds.length) {
      errors.push(`/Count ${declaredCount} != /Kids length ${kidIds.length}`);
    }

    for (const kidId of kidIds) {
      const offset = xref.offsets.get(kidId);
      if (offset === undefined || !(await objectHeaderMatches(fh, kidId, offset))) {
        errors.push(`page object ${kidId} missing from xref`);
        pages.push({ objectId: kidId, contentsObjectId: 0, imageObjectId: 0, hasPageType: false });
        continue;
      }
      const dict = await readObjectDict(fh, offset);
      const hasPageType = /\/Type\s*\/Page\b/.test(dict);
      if (!hasPageType) {
        errors.push(`object ${kidId} is not a /Type /Page`);
      }
      const contentsId = refValue(dict, 'Contents');
      if (contentsId === undefined) {
        errors.push(`page ${kidId} has no /Contents`);
        pages.push({ objectId: kidId, contentsObjectId: 0, imageObjectId: 0, hasPageType });
        continue;
      }
      const contentsOffset = xref.offsets.get(contentsId);
      if (
        contentsOffset === undefined ||
        !(await objectHeaderMatches(fh, contentsId, contentsOffset))
      ) {
        errors.push(`page ${kidId}: contents object ${contentsId} missing from xref`);
        pages.push({ objectId: kidId, contentsObjectId: contentsId, imageObjectId: 0, hasPageType });
        continue;
      }
      const xobjectMatch = /\/XObject\s*<<([^>]*)>>/.exec(dict);
      let imageId = 0;
      if (xobjectMatch !== null) {
        const ref = /(\d+)\s+\d+\s+R/.exec(xobjectMatch[1] ?? '');
        imageId = ref === null ? 0 : Number.parseInt(ref[1] ?? '', 10);
      }
      if (imageId === 0) {
        errors.push(`page ${kidId} has no image XObject`);
        pages.push({ objectId: kidId, contentsObjectId: contentsId, imageObjectId: 0, hasPageType });
        continue;
      }
      const imageOffset = xref.offsets.get(imageId);
      if (imageOffset === undefined || !(await objectHeaderMatches(fh, imageId, imageOffset))) {
        errors.push(`page ${kidId}: image object ${imageId} missing from xref`);
        pages.push({ objectId: kidId, contentsObjectId: contentsId, imageObjectId: imageId, hasPageType });
        continue;
      }
      const imageDict = await readObjectDict(fh, imageOffset);
      if (!/\/Subtype\s*\/Image\b/.test(imageDict)) {
        errors.push(`image object ${imageId} is not /Subtype /Image`);
      }
      if (!/\/Filter\s*\/(DCTDecode|FlateDecode)/.test(imageDict)) {
        errors.push(`image object ${imageId} carries no supported filter`);
      }
      pages.push({ objectId: kidId, contentsObjectId: contentsId, imageObjectId: imageId, hasPageType });
    }

    const pageCount = pages.filter((page) => page.hasPageType).length;
    if (expectedPageCount !== undefined && pageCount !== expectedPageCount) {
      errors.push(`page count ${pageCount} does not match expected ${expectedPageCount}`);
    }
    return {
      ok: errors.length === 0,
      errors,
      pageCount,
      declaredCount: declaredCount < 0 ? 0 : declaredCount,
      trailerSize: xref.trailerSize,
      pages,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { ok: false, errors, pageCount: 0, declaredCount: 0, trailerSize: 0, pages };
  } finally {
    await fh.close();
  }
}
