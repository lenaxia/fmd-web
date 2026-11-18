/**
 * Import-from-FMD2 client calls (two-phase API). These are MULTIPART
 * uploads — deliberately outside the generated openapi-fetch client
 * (JSON-shaped by design): plain same-origin fetch with FormData. The
 * typed PREVIEW/REPORT shapes mirror the OpenAPI schemas by hand here
 * (the wire contract lives in server/src/api/schemas.ts).
 */

/** One row of the analyze preview (server Fmd2ImportPreviewT). */
export interface Fmd2ImportPreview {
  readonly files: readonly string[];
  readonly ignored: readonly { readonly source: string; readonly reason: string }[];
  readonly favorites: {
    readonly total: number;
    readonly importable: number;
    readonly bySite: readonly {
      readonly moduleId: string;
      readonly siteName: string;
      readonly count: number;
      readonly mapped: boolean;
    }[];
    readonly unmappedSiteIds: readonly { readonly id: string; readonly count: number }[];
  };
  readonly downloadedLedger: { readonly rows: number; readonly matched: number };
  readonly settings: {
    readonly mappable: readonly {
      readonly key: string;
      readonly label: string;
      readonly source: string;
      readonly preview: string;
      readonly requiresCredentials: boolean;
    }[];
    readonly notImportable: readonly { readonly source: string; readonly reason: string }[];
  };
  readonly credentials: {
    readonly sites: readonly {
      readonly moduleId: string;
      readonly siteName: string;
      readonly fields: readonly string[];
    }[];
    readonly globalProxyAuth: boolean;
  };
  readonly analyzeToken: string;
}

/** The apply selections (server Fmd2ImportApplyRequestT). */
export interface Fmd2ApplySelections {
  readonly token?: string;
  readonly favorites?: boolean;
  readonly settings?: readonly string[];
  readonly credentials?: readonly string[];
}

/** The apply report (server Fmd2ImportApplyReportT). */
export interface Fmd2ImportReport {
  readonly favorites: {
    readonly created: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly skipped: readonly { readonly label: string; readonly reason: string }[];
    readonly unmappedSiteIds: readonly { readonly id: string; readonly count: number }[];
    readonly saveToPathsDropped: number;
  };
  readonly downloadedLedgerRowsApplied: number;
  readonly credentials: {
    readonly imported: readonly { readonly moduleId: string; readonly siteName: string; readonly fields: readonly string[] }[];
    readonly skipped: readonly { readonly moduleId: string; readonly reason: string }[];
  };
  readonly settings: {
    readonly applied: readonly { readonly key: string; readonly detail: string }[];
    readonly notImportable: readonly { readonly source: string; readonly reason: string }[];
  };
}

async function unwrap<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    let message = `${what} failed (${String(response.status)})`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message !== undefined) {
        message = body.error.message;
      }
    } catch {
      // non-JSON error body — keep the status-line message
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

/** Phase 1: upload the FMD2 files, get the preview (nothing written). */
export async function postFmd2Analyze(
  fetchImpl: typeof globalThis.fetch,
  files: readonly File[],
): Promise<Fmd2ImportPreview> {
  const form = new FormData();
  for (const file of files) {
    form.append('file', file, file.name);
  }
  return unwrap<Fmd2ImportPreview>(
    await fetchImpl('/api/import/fmd2/analyze', { method: 'POST', body: form }),
    'FMD2 analyze',
  );
}

/** Phase 2: apply the confirmed selections (server-held token). */
export async function postFmd2Apply(
  fetchImpl: typeof globalThis.fetch,
  selections: Fmd2ApplySelections,
): Promise<Fmd2ImportReport> {
  return unwrap<Fmd2ImportReport>(
    await fetchImpl('/api/import/fmd2/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(selections),
    }),
    'FMD2 apply',
  );
}
