/**
 * Phase-3 gate e2e (scripts/e2e.sh --phase3) — the FULL download
 * pipeline over the real stack: enqueue from the Manga page → WS
 * progress → pack → library listing → artifact download + ZIP
 * validation; cancel mid-download → cancelled → re-enqueue resumes via
 * the persisted 'D' markers (server request-count asserted); injected
 * 500s → job retry visible → eventual success.
 *
 * The only upstream is the fixture manga site (the e2e mock container /
 * process twin on 127.0.0.1:8091), whose failure-injection controls
 * (`/_control/*`) and request counters (`/_stats`) arm and verify the
 * scenarios. Traces are retained on failure by the compose config.
 */
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

interface E2EJson {
  readonly catalogId: string;
  readonly moduleName: string;
  readonly mangaTitle: string;
  readonly mangaPath: string;
  readonly chapterPages: Record<string, number>;
}

const E2E = JSON.parse(
  readFileSync(new URL('../../e2e/fixtures/e2e.json', import.meta.url), 'utf8'),
) as E2EJson;
interface FixtureManifest {
  readonly mockBase: string;
}
const MANIFEST = JSON.parse(
  readFileSync(new URL('../../e2e/.tmp/fixtures/upstream/manifest.json', import.meta.url), 'utf8'),
) as FixtureManifest;
const CATALOG_ID: string = E2E.catalogId;
const MODULE_ID: string = CATALOG_ID;
// The APP-facing base (embedded in the catalog/chapter links — the app
// fetches verbatim, so it must be the base THIS mode's app can reach:
// `http://e2e-mock:8081` under compose, loopback in process mode) vs the
// HOST-facing base the spec itself drives (/_control/*, /_stats — the
// mock's published host port in both modes).
const APP_MOCK_BASE = process.env['FMD_E2E_APP_MOCK_URL'] ?? MANIFEST.mockBase;
const HOST_MOCK = process.env['FMD_E2E_MOCK_URL'] ?? 'http://127.0.0.1:8091';
const MANGA_URL = `${APP_MOCK_BASE}${E2E.mangaPath}`;

interface JobSnapshot {
  readonly id: string;
  readonly state: string;
  readonly progress?: Record<string, unknown>;
}

/** Poll GET /api/jobs/:id until `predicate` holds (the WS feed patches
 * the UI live, but assertions key on the durable server truth). */
async function waitForJob(
  request: APIRequestContext,
  jobId: string,
  predicate: (job: JobSnapshot) => boolean,
  timeoutMs = 120_000,
): Promise<JobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: JobSnapshot | undefined;
  for (;;) {
    const response = await request.get(`/api/jobs/${jobId}`);
    expect(response.ok(), `GET /api/jobs/${jobId} → ${String(response.status())}`).toBeTruthy();
    const body = (await response.json()) as { job: JobSnapshot };
    last = body.job;
    if (predicate(last)) {
      return last;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} never satisfied the predicate — last state ${JSON.stringify(last)}`);
    }
    // 100 ms: transient states (running/retry dwell ≤ one lane-poll) must
    // stay observable to the state-history assertions.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Mock-side image-request count for one chapter prefix (/_stats). */
async function imageRequestCount(request: APIRequestContext, chapter: string): Promise<number> {
  const response = await request.get(`${HOST_MOCK}/_stats`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { paths: Record<string, number> };
  let total = 0;
  for (const [path, count] of Object.entries(body.paths)) {
    if (path.startsWith(`/manga/alpha-quest/ch/${chapter}/image/`)) {
      total += count;
    }
  }
  return total;
}

async function armInjection(
  request: APIRequestContext,
  kind: 'fail500' | 'slow',
  body: Record<string, unknown>,
): Promise<void> {
  const response = await request.post(`${HOST_MOCK}/_control/${kind}`, { data: body });
  expect(response.ok(), `arm ${kind} → ${String(response.status())}`).toBeTruthy();
}

async function resetInjection(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${HOST_MOCK}/_control/reset`, { data: {} });
  expect(response.ok()).toBeTruthy();
}

/** Navigate straight to the manga detail page for one chapter enqueue. */
async function openMangaPage(page: Page): Promise<void> {
  await page.goto(
    `/#/manga?module=${MODULE_ID}&url=${encodeURIComponent(MANGA_URL)}&title=${encodeURIComponent(E2E.mangaTitle)}&catalog=${CATALOG_ID}`,
  );
  await expect(page.getByRole('heading', { name: E2E.mangaTitle })).toBeVisible({ timeout: 30_000 });
}

/** Enqueue one chapter by its chapter name; returns the queued job id. */
async function enqueueChapter(page: Page, chapterName: string): Promise<string> {
  await openMangaPage(page);
  await page.getByLabel(chapterName).check();
  await page.getByRole('button', { name: /Enqueue 1 chapter/ }).click();
  const status = page.getByRole('status').filter({ hasText: /queued/ });
  await expect(status).toBeVisible({ timeout: 15_000 });
  const text = (await status.textContent()) ?? '';
  const match = /Job <code>(\d+)<\/code> queued|Job (\d+) queued/.exec(text);
  if (match !== null) {
    return match[1] ?? match[2] ?? '';
  }
  // The <code> element renders separately from the text content in some
  // engines — fall back to the jobs list (newest first).
  return '';
}

/** The newest job id via /api/jobs (fallback when the status text parsing is brittle). */
async function newestJobId(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/jobs?limit=1');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { jobs: readonly { id: string }[] };
  const first = body.jobs[0];
  if (first === undefined) {
    throw new Error('jobs list is empty — the enqueue never landed');
  }
  return first.id;
}

/** Fixture chapter page count (e2e.json chapterPages); loud when absent. */
function chapterPageCount(chapter: string): number {
  const pages = E2E.chapterPages[chapter];
  if (pages === undefined) {
    throw new Error(`e2e.json chapterPages has no entry for chapter ${chapter}`);
  }
  return pages;
}

// ── minimal ZIP central-directory walk (no cross-workspace imports) ──

interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly method: number;
}

function walkZipCentralDirectory(bytes: Uint8Array): readonly ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  // EOCD: scan the last 64 KiB for the 0x06054b50 signature.
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65_536); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('not a zip: End Of Central Directory signature not found');
  }
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(`corrupt zip: central entry ${String(i)} signature missing`);
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, uncompressedSize });
    offset += 46 + nameLength;
  }
  return entries;
}

test.describe('phase3 — download → pack → library → cancel/resume → retry', (): void => {
  test('scenario 1: enqueue → WS progress → library listing → artifact validates', async ({ page, request }): Promise<void> => {
    test.setTimeout(180_000);
    await enqueueChapter(page, 'Chapter 1: The Beginning');
    const jobId = await newestJobId(request);

    // WS progress: the Downloads page LIVE-patches the row (no reload) —
    // badge queued → running → (compressing →) finished and the coalesced
    // progress text ([downloads-parity] badge vocabulary; server state
    // stays 'done' — the badge token is 'finished').
    await page.getByRole('link', { name: 'Downloads' }).click();
    const row = page.locator(`.job-row[data-job-id="${jobId}"]`);
    await expect(row.locator('.badge')).toHaveText(/queued|preparing|running|compressing|finished/, { timeout: 30_000 });
    await expect(row).not.toContainText('queued', { timeout: 60_000 });
    await expect(row.locator('.badge')).toHaveText('finished', { timeout: 120_000 });
    // progress surfaced the download counts (WS snapshots, §4 coalesced)
    await expect(row.locator('.job-progress')).toHaveAttribute('data-done', '3');
    await expect(page.getByText('Event stream: Live')).toBeVisible();
    const job = await waitForJob(request, jobId, (j): boolean => j.state === 'done');
    expect(job.progress?.['total']).toBe(chapterPageCount('1'));

    // library listing shows the packed file
    await page.getByRole('link', { name: 'Library' }).click();
    const libraryRow = page.locator('.library-row', { hasText: 'Chapter 1 The Beginning.zip' });
    await expect(libraryRow).toBeVisible({ timeout: 30_000 });

    // artifact download + ZIP structure validation (central directory)
    const id = await libraryRow.getAttribute('data-file-id');
    expect(id).not.toBeNull();
    const response = await request.get(`/api/library/${String(id)}/file`);
    expect(response.ok()).toBeTruthy();
    const disposition = response.headers()['content-disposition'] ?? '';
    expect(disposition).toContain('Chapter 1 The Beginning.zip');
    const bytes = await response.body();
    const entries = walkZipCentralDirectory(bytes);
    expect(entries.map((entry) => entry.name).sort()).toEqual(['001.jpg', '002.jpg', '003.jpg']);
    for (const entry of entries) {
      expect(entry.uncompressedSize).toBeGreaterThan(0);
      expect(entry.method).toBe(0); // stored (D16: images are stored raw)
    }
  });

  test('scenario 2: slow images → cancel mid-download → cancelled → re-enqueue resumes via markers', async ({ page, request }): Promise<void> => {
    test.setTimeout(240_000);
    const chapter = '2';
    const total = chapterPageCount(chapter);
    expect(total).toBeGreaterThan(12); // a LONG chapter: room to cancel mid-flight

    // slow-image injection: every image takes long enough to cancel comfortably
    await armInjection(request, 'slow', { path: `/manga/alpha-quest/ch/${chapter}/image/`, ms: 400, count: total });

    await enqueueChapter(page, 'Chapter 2: The Middle');
    const jobId = await newestJobId(request);
    await waitForJob(request, jobId, (j): boolean => j.state === 'running');

    // wait until ≥2 images are DOWNLOADED (coalesced progress; the mock
    // request counter alone would race unsaved in-flight fetches)
    await waitForJob(
      request,
      jobId,
      (j): boolean => typeof j.progress?.['done'] === 'number' && (j.progress['done'] as number) >= 2,
      90_000,
    );

    // stop FROM THE UI: [downloads-parity] replaced the standalone Cancel
    // button with the Pause primary action — pause on a RUNNING job is the
    // resume-able user-cancel (markers persist; server state 'cancelled',
    // badge token 'stopped').
    await page.getByRole('link', { name: 'Downloads' }).click();
    const row = page.locator(`.job-row[data-job-id="${jobId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: `Pause job ${jobId}` }).click();
    await expect(row.locator('.badge')).toHaveText('stopped', { timeout: 30_000 });
    await waitForJob(request, jobId, (j): boolean => j.state === 'cancelled');
    await resetInjection(request);

    // server request-count: the cancelled attempt fetched strictly less
    // than the whole chapter (some images never fetched)
    const fetchedBeforeResume = await imageRequestCount(request, chapter);
    expect(fetchedBeforeResume).toBeGreaterThan(0);
    expect(fetchedBeforeResume).toBeLessThan(total + 2);

    // re-enqueue the SAME chapter → a FRESH job (terminal replay chains)
    // that resumes from the persisted markers: images already on disk
    // ('D') are NOT re-fetched — the request count proves it.
    await enqueueChapter(page, 'Chapter 2: The Middle');
    const resumeJobId = await newestJobId(request);
    expect(Number(resumeJobId)).toBeGreaterThan(Number(jobId));
    await waitForJob(request, resumeJobId, (j): boolean => j.state === 'done', 180_000);

    const fetchedAfterResume = await imageRequestCount(request, chapter);
    // every image was SERVED at least once across both runs …
    expect(fetchedAfterResume).toBeGreaterThanOrEqual(total);
    // … but the RESUME fetched strictly fewer than a full chapter — the
    // 'D' markers skipped the already-downloaded images.
    expect(fetchedAfterResume - fetchedBeforeResume).toBeLessThan(total);

    // the resume landed as a library entry too
    await page.getByRole('link', { name: 'Library' }).click();
    await expect(
      page.locator('.library-row', { hasText: 'Chapter 2 The Middle.zip' }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('scenario 3: injected 500s → retry visible → recovers', async ({ page, request }): Promise<void> => {
    test.setTimeout(180_000);
    const chapter = '3';
    const total = chapterPageCount(chapter);

    // the first 3 image GETs return 500 (per-image retry parity: exactly
    // 500 does NOT in-image-retry — the chapter attempt fails and the
    // JOB retries, resuming from markers)
    await armInjection(request, 'fail500', { path: `/manga/alpha-quest/ch/${chapter}/image/`, count: 3 });

    await enqueueChapter(page, 'Chapter 3: The Finale');
    const jobId = await newestJobId(request);

    // the retry state must be VISIBLE on the job (badge + server truth)
    const seen = new Set<string>();
    await waitForJob(request, jobId, (j): boolean => {
      seen.add(j.state);
      return j.state === 'done';
    });
    expect(seen.has('retry'), `retry state never observed: ${[...seen].join(', ')}`).toBeTruthy();

    await page.getByRole('link', { name: 'Downloads' }).click();
    const row = page.locator(`.job-row[data-job-id="${jobId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('.badge')).toHaveText('finished', { timeout: 30_000 });

    // server request-count: 2 images needed ≥5 GETs (3×500 + ≥2×200)
    const imageRequests = await imageRequestCount(request, chapter);
    expect(imageRequests).toBeGreaterThanOrEqual(total + 3);

    // and the recovered chapter packs + lands in the library
    await page.getByRole('link', { name: 'Library' }).click();
    const libraryRow = page.locator('.library-row', { hasText: 'Chapter 3 The Finale.zip' });
    await expect(libraryRow).toBeVisible({ timeout: 30_000 });
    const id = await libraryRow.getAttribute('data-file-id');
    const response = await request.get(`/api/library/${String(id)}/file`);
    expect(response.ok()).toBeTruthy();
    const entries = walkZipCentralDirectory(await response.body());
    expect(entries.map((entry) => entry.name).sort()).toEqual(['001.jpg', '002.jpg']);
  });
});
