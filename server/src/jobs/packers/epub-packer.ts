import { fileExtensionOf, paddedPageNumber, xmlEscape } from './archive-common.js';
import { imageMediaTypeFor, sanitizeArchiveEntryName } from './page-source.js';
import { runArchiverPack } from './archiver-pack.js';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { PackOptions, PackPageInput, PackResult, Packer, PackFormat } from './types.js';

/**
 * EPUB streaming builder (DESIGN.md §7.3): zip-based, OCFF-compliant —
 * the `mimetype` entry is written FIRST and stored uncompressed; the
 * container.xml, OPF (manifest + spine in reading order), and nav
 * document are appended; then pages stream in chapter order (page
 * XHTML + its image, append-per-image, images STORE'd). Same D16
 * budget/watchdog scaffolding as the ZIP packer.
 */

const EPUB_MIMETYPE = 'application/epub+zip';

interface EpubPagePlan {
  readonly workId: number;
  readonly pageHref: string;
  readonly entryPath: string;
  readonly imageHref: string;
  readonly imageEntryPath: string;
  readonly mediaType: string;
  readonly storeImage: boolean;
  readonly source: PackPageInput;
}

function planPages(pages: readonly PackPageInput[]): EpubPagePlan[] {
  return pages.map((page, index) => {
    const padded = paddedPageNumber(index + 1, pages.length);
    const ext = fileExtensionOf(sanitizeArchiveEntryName(page.fileName)) || '.img';
    return {
      workId: page.workId,
      pageHref: `text/p${padded}.xhtml`,
      entryPath: `OEBPS/text/p${padded}.xhtml`,
      imageHref: `images/p${padded}${ext}`,
      imageEntryPath: `OEBPS/images/p${padded}${ext}`,
      mediaType: imageMediaTypeFor(page.fileName),
      storeImage: true,
      source: page,
    };
  });
}

function containerXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    '  <rootfiles>',
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>',
    '  </rootfiles>',
    '</container>',
    '',
  ].join('\n');
}

function pageXhtml(plan: EpubPagePlan): string {
  const alt = `Page ${plan.workId + 1}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    `  <head><title>${xmlEscape(alt)}</title></head>`,
    '  <body>',
    `    <div class="page"><img src="../${plan.imageHref}" alt="${xmlEscape(alt)}"/></div>`,
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

function contentOpf(plans: readonly EpubPagePlan[], title: string, uid: string): string {
  const manifest = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ...plans.map(
      (plan) =>
        `    <item id="p${plan.workId}" href="${plan.pageHref}" media-type="application/xhtml+xml"/>`,
    ),
    ...plans.map(
      (plan, index) =>
        `    <item id="img${index + 1}" href="${plan.imageHref}" media-type="${plan.mediaType}"/>`,
    ),
  ];
  const spine = plans.map((plan) => `    <itemref idref="p${plan.workId}"/>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `    <dc:identifier id="bookid">urn:uuid:${uid}</dc:identifier>`,
    `    <dc:title>${xmlEscape(title)}</dc:title>`,
    '    <dc:language>en</dc:language>',
    `    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>`,
    '  </metadata>',
    '  <manifest>',
    ...manifest,
    '  </manifest>',
    '  <spine>',
    ...spine,
    '  </spine>',
    '</package>',
    '',
  ].join('\n');
}

function navXhtml(plans: readonly EpubPagePlan[]): string {
  const items = plans.map(
    (plan) => `      <li><a href="${plan.pageHref}">${plan.workId + 1}</a></li>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">',
    '  <head><title>Table of contents</title></head>',
    '  <body>',
    '    <nav epub:type="toc" id="toc">',
    '      <ol>',
    ...items,
    '      </ol>',
    '    </nav>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

export class EpubPacker implements Packer {
  readonly format: PackFormat = 'epub';

  async pack(pages: readonly PackPageInput[], options: PackOptions): Promise<PackResult> {
    const plans = planPages(pages);
    const uid = randomUUID();
    const title = options.title ?? 'Chapter';
    const container = containerXml();
    const opf = contentOpf(plans, title, uid);
    const nav = navXhtml(plans);

    return runArchiverPack('epub', options, async (ctx) => {
      // OCFF: mimetype must be the first entry, stored uncompressed.
      ctx.archive.append(Buffer.from(EPUB_MIMETYPE, 'utf8'), { name: 'mimetype', store: true });
      ctx.charge(Buffer.byteLength(container) + Buffer.byteLength(opf) + Buffer.byteLength(nav));
      ctx.archive.append(Buffer.from(container, 'utf8'), { name: 'META-INF/container.xml' });
      ctx.archive.append(Buffer.from(opf, 'utf8'), { name: 'OEBPS/content.opf' });
      ctx.archive.append(Buffer.from(nav, 'utf8'), { name: 'OEBPS/nav.xhtml' });

      let packed = 0;
      for (const plan of plans) {
        ctx.sample();
        const xhtml = pageXhtml(plan);
        ctx.charge(Buffer.byteLength(xhtml));
        ctx.archive.append(Buffer.from(xhtml, 'utf8'), { name: plan.entryPath });
        const source =
          plan.source.openStream !== undefined
            ? plan.source.openStream()
            : createReadStream(plan.source.filePath);
        ctx.archive.append(source, { name: plan.imageEntryPath, store: plan.storeImage });
        packed += 1;
        ctx.reportPageProgress(packed, plans.length);
      }
      return plans.length;
    });
  }
}
