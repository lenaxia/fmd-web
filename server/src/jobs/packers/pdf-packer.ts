import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tempPackOutputPath, wrapPackIo } from './archive-common.js';
import { openPageSource } from './page-source.js';
import { probeEmbeddableImage, streamPngIdatTo, type ImageProbe } from './probe-image.js';
import { MemoryBudget } from './budget.js';
import { PackError } from './errors.js';
import { Deferred, copyStream, waitForClose, writeChunk } from './stream-utils.js';
import { PackWatchdog } from './watchdog.js';
import type { PackOptions, PackPageInput, PackResult, Packer } from './types.js';

/**
 * PDF streaming packer — the D16 commitment (DESIGN.md §7.3, D16):
 * pages are appended INCREMENTALLY to a disk-backed output file; each
 * page's image bytes pass through from the page file to the PDF in
 * bounded 64 KiB slices (JPEG = DCTDecode passthrough, PNG =
 * FlateDecode with PNG-predictor DecodeParms — no pixel decode, no
 * re-encode). Only tiny metadata (object offsets, /Kids refs, xref)
 * is held in memory and charged against the budget.
 *
 * pdf-lib is deliberately NOT used: it materializes the entire
 * document in memory, which the 512 MB per-job budget forbids for
 * large chapters (documented D16 divergence — this writer is the
 * streaming replacement). The per-object/append order here is plain
 * classic PDF 1.7 (xref table, no object streams) so validators and
 * viewers can parse it positionally.
 *
 * Object numbering: 1 = catalog, 2 = pages, 3 = info, pages/images/
 * contents from 4 up (allocated contiguously as pages arrive). The
 * catalog/pages/info objects and the xref table are appended at close.
 */

/** Object ids reserved before page objects start. */
const CATALOG_ID = 1;
const PAGES_ID = 2;
const INFO_ID = 3;
const FIRST_PAGE_OBJECT_ID = 4;

const COPY_SLICE_BYTES = 256 * 1024;

interface PdfPageObjectIds {
  readonly paletteId?: number;
  readonly imageId: number;
  readonly contentId: number;
  readonly pageId: number;
}

/** Escape a PDF literal string (PDFDocEncoding-safe ASCII subset). */
function pdfStringEscape(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/g, '')
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)');
}

function pad10(value: number): string {
  return String(value).padStart(10, '0');
}

export class PdfPacker implements Packer {
  readonly format = 'pdf' as const;

  async pack(pages: readonly PackPageInput[], options: PackOptions): Promise<PackResult> {
    const started = Date.now();
    const budget = new MemoryBudget(options.memoryBudgetBytes);
    const watchdog = new PackWatchdog(options.watchdogMs);
    const outPath = await tempPackOutputPath(options.outputDir, 'pdf');
    const out = createWriteStream(outPath, { highWaterMark: 1 << 20 });
    // Attach before any write: 'close' can fire the moment the last
    // small chunk flushes — a late listener would wait forever.
    const closePromise = waitForClose(out);
    closePromise.catch(() => undefined);
    const pipelineFailure = new Deferred<never>();
    out.on('error', (error: unknown) => {
      pipelineFailure.reject(wrapPackIo(error, 'pack output stream failed'));
    });
    watchdog.start();

    /** offsets[id] = byte offset of `id 0 obj` (index 0 unused). */
    const offsets: number[] = [];
    let nextId = FIRST_PAGE_OBJECT_ID;
    const kids: number[] = [];

    /**
     * LOGICAL position, advanced at enqueue time — `out.bytesWritten`
     * only counts fd-flushed bytes and lags behind buffered writes, so
     * object offsets recorded from it drift once the stream pipelines.
     */
    let position = 0;
    const writeOut = async (data: string | Buffer): Promise<void> => {
      position += typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
      await writeChunk(out, data);
    };

    const recordOffset = (id: number): void => {
      offsets[id] = position;
    };

    /**
     * A sink wrapper for stream-body producers (image byte passthrough):
     * every chunk it writes is accounted into the logical position.
     */
    const trackedSink = (): NodeJS.WritableStream => {
      const target = out as unknown as {
        write(chunk: Buffer): boolean;
        on(event: string, listener: (...args: never[]) => void): unknown;
        removeListener(event: string, listener: (...args: never[]) => void): unknown;
      };
      return {
        write(chunk: unknown): boolean {
          const bytes = chunk as Buffer;
          position += bytes.length;
          return target.write(bytes);
        },
        on(event: string, listener: (...args: never[]) => void): unknown {
          return target.on(event, listener);
        },
        removeListener(event: string, listener: (...args: never[]) => void): unknown {
          return target.removeListener(event, listener);
        },
      } as unknown as NodeJS.WritableStream;
    };

    const writePlainObject = async (id: number, dict: string): Promise<void> => {
      recordOffset(id);
      await writeOut(`${id} 0 obj\n<< ${dict} >>\nendobj\n`);
    };

    const writeStreamObject = async (
      id: number,
      dict: string,
      data: Buffer | string,
    ): Promise<void> => {
      recordOffset(id);
      const length = typeof data === 'string' ? Buffer.byteLength(data, 'latin1') : data.length;
      await writeOut(`${id} 0 obj\n<< ${dict} /Length ${length} >>\nstream\n`);
      await writeOut(data);
      await writeOut('\nendstream\nendobj\n');
    };

    /** Stream-object variant with a generator producing the raw bytes. */
    const writeStreamObjectFrom = async (
      id: number,
      dict: string,
      produce: (out2: NodeJS.WritableStream) => Promise<number>,
    ): Promise<void> => {
      recordOffset(id);
      await writeOut(`${id} 0 obj\n<< ${dict} >>\nstream\n`);
      await produce(trackedSink());
      await writeOut('\nendstream\nendobj\n');
    };

    const writeJpegImage = async (id: number, probe: ImageProbe, filePath: string): Promise<void> => {
      const components = probe.jpeg?.components ?? 3;
      const colorSpace =
        components === 1 ? '/DeviceGray' : components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      const decode = components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
      const size = (await stat(filePath)).size;
      const dict =
        `/Type /XObject /Subtype /Image /Width ${probe.width} /Height ${probe.height} ` +
        `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode${decode}`;
      await writeStreamObjectFrom(id, `${dict} /Length ${size}`, async (sink) => {
        const source = createReadStream(filePath, { highWaterMark: COPY_SLICE_BYTES });
        try {
          return await copyStream(source, sink);
        } finally {
          source.destroy();
        }
      });
    };

    const writePngImage = async (
      id: number,
      probe: ImageProbe,
      filePath: string,
      paletteId: number | undefined,
    ): Promise<void> => {
      const png = probe.png;
      if (png === undefined) {
        throw new PackError('pack-io', 'png page lost its probe between passes');
      }
      const colorSpace =
        paletteId !== undefined
          ? `[/Indexed /DeviceRGB ${png.paletteBytes !== undefined ? png.paletteBytes.length / 3 - 1 : 0} ${paletteId} 0 R]`
          : png.colors === 1
            ? '/DeviceGray'
            : '/DeviceRGB';
      const dict =
        `/Type /XObject /Subtype /Image /Width ${probe.width} /Height ${probe.height} ` +
        `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /FlateDecode ` +
        `/DecodeParms << /Predictor 15 /Colors ${png.colors} /BitsPerComponent 8 /Columns ${probe.width} >>`;
      await writeStreamObjectFrom(id, `${dict} /Length ${png.idatBytes}`, async (sink) => {
        const source = createReadStream(filePath, { highWaterMark: COPY_SLICE_BYTES });
        try {
          return await streamPngIdatTo(source, sink);
        } finally {
          source.destroy();
        }
      });
    };

    const writePage = async (
      ids: PdfPageObjectIds,
      probe: ImageProbe,
      imageDictName: string,
    ): Promise<void> => {
      const content = `q\n${probe.width} 0 0 ${probe.height} 0 0 cm\n/${imageDictName} Do\nQ\n`;
      await writeStreamObject(ids.contentId, '', content);
      const resources = `<< /XObject << /${imageDictName} ${ids.imageId} 0 R >> >>`;
      await writePlainObject(
        ids.pageId,
        `/Type /Page /Parent ${PAGES_ID} 0 R /MediaBox [0 0 ${probe.width} ${probe.height}] ` +
          `/Resources ${resources} /Contents ${ids.contentId} 0 R`,
      );
    };

    const packPages = async (): Promise<number> => {
      // Classic header + binary comment line.
      await writeOut('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

      let packed = 0;
      for (const page of pages) {
        watchdog.checkAlive();
        budget.sample();

        // Pass 1 — bounded-memory probe of the page image.
        const probeSource = openPageSource(page);
        const probe = await probeEmbeddableImage(probeSource, page.fileName);

        const paletteId =
          probe.png?.paletteBytes !== undefined ? nextId++ : undefined;
        const imageId = nextId++;
        const contentId = nextId++;
        const pageId = nextId++;
        const ids: PdfPageObjectIds = {
          ...(paletteId !== undefined ? { paletteId } : {}),
          imageId,
          contentId,
          pageId,
        };

        if (paletteId !== undefined && probe.png?.paletteBytes !== undefined) {
          await writeStreamObject(paletteId, '', probe.png.paletteBytes);
        }

        if (probe.kind === 'jpeg') {
          await writeJpegImage(imageId, probe, page.filePath);
        } else {
          await writePngImage(imageId, probe, page.filePath, paletteId);
        }

        await writePage(ids, probe, 'Im0');
        kids.push(pageId);
        packed += 1;
        options.onProgress?.({
          pagesPacked: packed,
          total: pages.length,
          bytesPacked: position,
        });
      }
      return packed;
    };

    const closeDocument = async (): Promise<void> => {
      const title = pdfStringEscape(options.title ?? 'Chapter');
      const kidsRefs = kids.map((id) => `${id} 0 R`).join(' ');
      budget.charge(kidsRefs.length + title.length + 4096);
      await writePlainObject(PAGES_ID, `/Type /Pages /Count ${kids.length} /Kids [${kidsRefs}]`);
      await writePlainObject(CATALOG_ID, `/Type /Catalog /Pages ${PAGES_ID} 0 R`);
      await writePlainObject(INFO_ID, `/Title (${title})`);

      const maxId = nextId - 1;
      const xrefOffset = position;
      const xrefLines: string[] = [`xref\n0 ${maxId + 1}\n`, '0000000000 65535 f \n'];
      for (let id = 1; id <= maxId; id += 1) {
        xrefLines.push(`${pad10(offsets[id] ?? 0)} 00000 n \n`);
      }
      xrefLines.push(
        `trailer\n<< /Size ${maxId + 1} /Root ${CATALOG_ID} 0 R /Info ${INFO_ID} 0 R >>\n`,
        `startxref\n${xrefOffset}\n%%EOF\n`,
      );
      const xrefText = xrefLines.join('');
      budget.charge(xrefText.length);
      await writeOut(xrefText);
      // Signal EOF — 'finish' → 'close' (autoClose) resolve closePromise.
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.once('error', (error: unknown) => reject(error));
      });
    };

    try {
      const work = (async (): Promise<number> => {
        const pageCount = await packPages();
        await closeDocument();
        return pageCount;
      })();
      const pageCount = await watchdog.race(Promise.race([work, pipelineFailure.promise]));
      await watchdog.race(Promise.race([closePromise, pipelineFailure.promise]));
      return {
        format: 'pdf',
        filePath: outPath,
        bytes: position,
        pageCount,
        peakHeapBytes: budget.peakHeapBytes,
        peakRssBytes: budget.peakRssBytes,
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      out.destroy();
      await rm(outPath, { force: true }).catch(() => undefined);
      throw error instanceof PackError ? error : wrapPackIo(error, 'pack failed');
    } finally {
      watchdog.dispose();
    }
  }
}
