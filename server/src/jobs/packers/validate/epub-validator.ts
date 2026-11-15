import { DOMParser } from 'linkedom';
import { readZipEntry, validateZipArchive } from './zip-validator.js';

/**
 * EPUB structural validator (§13 packer outputs): checks the OCFF
 * container rules the packer is bound to — `mimetype` is the FIRST
 * entry and stored uncompressed with the exact media type — parses
 * META-INF/container.xml → the OPF package document, resolves every
 * spine itemref through the manifest, and verifies each referenced
 * document exists as a ZIP entry. With `expectedPageHrefs` it also
 * asserts the spine (reading order) matches the chapter page order.
 */

export interface EpubManifestItem {
  readonly id: string;
  readonly href: string;
  readonly mediaType: string;
  readonly properties: string;
}

export interface EpubValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly mimetypeFirstStored: boolean;
  readonly opfPath: string;
  readonly spineHrefs: string[];
  readonly manifestItems: EpubManifestItem[];
  readonly imageCount: number;
}

interface SpineContext {
  readonly manifest: Map<string, EpubManifestItem>;
  readonly spineHrefs: string[];
  readonly entryNames: Set<string>;
  readonly opfDir: string;
}

/** XML-mode parser — self-closing OPF/container elements stay flat. */
function parseXml(xml: string) {
  return new DOMParser().parseFromString(xml, 'text/xml');
}

function parseManifestItem(element: Element): EpubManifestItem | undefined {
  const id = element.getAttribute('id');
  const href = element.getAttribute('href');
  if (id === null || href === null) {
    return undefined;
  }
  return {
    id,
    href,
    mediaType: element.getAttribute('media-type') ?? '',
    properties: element.getAttribute('properties') ?? '',
  };
}

/** Resolve an OPF-relative href to its zip entry path. */
function entryPathFor(opfDir: string, href: string): string {
  return `${opfDir}${href}`;
}

async function readSpineContext(filePath: string, opfPath: string): Promise<SpineContext> {
  const opfBytes = await readZipEntry(filePath, opfPath);
  const document = parseXml(opfBytes.toString('utf8'));
  const manifest = new Map<string, EpubManifestItem>();
  for (const element of document.querySelectorAll('manifest > item')) {
    const item = parseManifestItem(element);
    if (item !== undefined) {
      manifest.set(item.id, item);
    }
  }
  const opfDir = opfPath.includes('/') ? `${opfPath.slice(0, opfPath.lastIndexOf('/'))}/` : '';
  const walk = await validateZipArchive(filePath);
  const entryNames = new Set(walk.entries.map((entry) => entry.name));
  const spineHrefs: string[] = [];
  for (const itemref of document.querySelectorAll('spine > itemref')) {
    const idref = itemref.getAttribute('idref');
    if (idref === null) {
      continue;
    }
    const item = manifest.get(idref);
    if (item !== undefined) {
      spineHrefs.push(item.href);
    }
  }
  return { manifest, spineHrefs, entryNames, opfDir };
}

/**
 * Validate one EPUB file. `expectedPageHrefs` (OPF-relative, e.g.
 * `text/p0001.xhtml`) asserts the spine equals the chapter page order.
 */
export async function validateEpub(
  filePath: string,
  expectedPageHrefs?: readonly string[],
): Promise<EpubValidationResult> {
  const errors: string[] = [];

  // 1) Container-level checks via the ZIP validator (no order expectation).
  const zip = await validateZipArchive(filePath);
  errors.push(...zip.errors.map((message) => `zip: ${message}`));

  // 2) OCFF: mimetype first, stored (method 0), exact content.
  let mimetypeFirstStored = false;
  const first = zip.entries[0];
  if (first === undefined || first.name !== 'mimetype') {
    errors.push(`first entry is ${first?.name ?? '<none>'}, expected 'mimetype'`);
  } else if (first.method !== 0) {
    errors.push('mimetype entry must be stored uncompressed (method 0)');
  } else {
    mimetypeFirstStored = true;
  }
  if (mimetypeFirstStored) {
    const mimetype = (await readZipEntry(filePath, 'mimetype')).toString('utf8');
    if (mimetype !== 'application/epub+zip') {
      errors.push(`mimetype content is '${mimetype}', expected 'application/epub+zip'`);
    }
  }

  // 3) container.xml → rootfile (OPF path).
  let opfPath = '';
  let container: ReturnType<typeof parseXml> | undefined;
  try {
    const containerBytes = await readZipEntry(filePath, 'META-INF/container.xml');
    container = parseXml(containerBytes.toString('utf8'));
    const rootfile = container.querySelector('rootfile');
    opfPath = rootfile?.getAttribute('full-path') ?? '';
    if (opfPath === '') {
      errors.push('container.xml has no rootfile full-path');
    }
  } catch (error) {
    container = undefined;
    errors.push(`container.xml unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 4) OPF parse + spine resolution.
  let manifestItems: EpubManifestItem[] = [];
  let spineHrefs: string[] = [];
  let imageCount = 0;
  if (opfPath !== '') {
    try {
      const context = await readSpineContext(filePath, opfPath);
      manifestItems = [...context.manifest.values()];
      spineHrefs = context.spineHrefs;
      imageCount = manifestItems.filter((item) => item.mediaType.startsWith('image/')).length;
      if (manifestItems.length === 0) {
        errors.push('OPF manifest has no items');
      }
      if (spineHrefs.length === 0) {
        errors.push('OPF spine has no resolvable itemrefs');
      }
      for (const href of spineHrefs) {
        const entry = entryPathFor(context.opfDir, href);
        if (!context.entryNames.has(entry)) {
          errors.push(`spine reference '${href}' does not resolve to zip entry '${entry}'`);
        }
      }
      const navItem = manifestItems.find((item) => item.properties.includes('nav'));
      if (navItem !== undefined && !context.entryNames.has(entryPathFor(context.opfDir, navItem.href))) {
        errors.push(`nav document '${navItem.href}' missing from the archive`);
      }
      for (const item of manifestItems) {
        if (item.mediaType.startsWith('image/')) {
          const entry = entryPathFor(context.opfDir, item.href);
          if (!context.entryNames.has(entry)) {
            errors.push(`manifest image '${item.href}' missing from the archive`);
          }
        }
      }
    } catch (error) {
      errors.push(`OPF parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 5) Reading order check (the acceptance-criteria spine test).
  if (expectedPageHrefs !== undefined && spineHrefs.length > 0) {
    if (spineHrefs.length !== expectedPageHrefs.length) {
      errors.push(`spine holds ${spineHrefs.length} pages, expected ${expectedPageHrefs.length}`);
    }
    const count = Math.min(spineHrefs.length, expectedPageHrefs.length);
    for (let i = 0; i < count; i += 1) {
      const actual = spineHrefs[i] ?? '';
      const expected = expectedPageHrefs[i] ?? '';
      if (actual !== expected) {
        errors.push(`reading order mismatch at ${i}: spine '${actual}', expected '${expected}'`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    mimetypeFirstStored,
    opfPath,
    spineHrefs,
    manifestItems,
    imageCount,
  };
}
