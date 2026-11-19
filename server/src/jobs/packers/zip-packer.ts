import { runArchiverPack } from './archiver-pack.js';
import { sanitizeArchiveEntryName } from './archive-common.js';
import { buildComicInfoXml, COMIC_INFO_ENTRY_NAME } from './comic-info.js';
import { openPageSource } from './page-source.js';
import type { PackFormat, PackOptions, PackPageInput, PackResult, Packer } from './types.js';

/**
 * ZIP/CBZ streaming packer (DESIGN.md §7.3): one archiver instance
 * piped into a disk-backed output file; every page is appended as its
 * own file stream (append-per-image) with the STORE method — image
 * bytes are already compressed and the D16 discipline keeps the pack
 * constant-memory. CBZ is the same container with the comic book
 * extension (recognized as a ZIP by any reader).
 *
 * ComicInfo.xml (D1 §2 EXIT): when `options.comicInfo` is present the
 * metadata document is appended as the FIRST entry (STORE — it is a
 * few hundred bytes of UTF-8 text), ahead of the pages, so a scanner
 * reading the archive meets the metadata before any image.
 */
export class ZipPacker implements Packer {
  private readonly kind: 'zip' | 'cbz';

  constructor(format: 'zip' | 'cbz') {
    this.kind = format;
  }

  get format(): PackFormat {
    return this.kind;
  }

  async pack(pages: readonly PackPageInput[], options: PackOptions): Promise<PackResult> {
    const total = pages.length;
    return runArchiverPack(this.kind, options, async (ctx) => {
      if (options.comicInfo !== undefined) {
        ctx.sample();
        ctx.archive.append(Buffer.from(buildComicInfoXml(options.comicInfo), 'utf8'), {
          name: COMIC_INFO_ENTRY_NAME,
          store: true,
        });
      }
      let packed = 0;
      for (const page of pages) {
        ctx.sample();
        const source = openPageSource(page);
        source.on('error', () => undefined); // surfaced via archiver error event
        ctx.archive.append(source, {
          name: sanitizeArchiveEntryName(page.fileName),
          store: true,
        });
        packed += 1;
        ctx.reportPageProgress(packed, total);
      }
      return total;
    });
  }
}
