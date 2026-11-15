import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  readMarkers,
  writeMarkers,
} from '../../../src/jobs/download/marker-store.js';
import { mkTmpDir, rmDir } from '../helpers.js';

/**
 * 'W'/'D' marker persistence (DESIGN §7.1: "persisted, resumable across
 * restarts"): the PageLinks marker list survives the process in the
 * chapter work dir via an atomic JSON write — the resume contract the
 * Cancel/Resume integration tests build on.
 */
describe('marker-store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmpDir('markers-');
  });

  afterEach(() => {
    rmDir(dir);
  });

  it('roundtrips marker lists verbatim (URLs + W/D markers)', async () => {
    const markers = ['http://x/1.jpg', 'D', 'D', 'W', 'http://x/5.jpg'];
    writeMarkers(dir, markers);
    expect(readMarkers(dir)).toEqual(markers);
  });

  it('reads undefined when no marker file exists (fresh chapter)', () => {
    expect(readMarkers(dir)).toBeUndefined();
  });

  it('overwrites previous state atomically (no partial reads)', () => {
    writeMarkers(dir, ['W', 'W', 'W']);
    writeMarkers(dir, ['D', 'D', 'D']);
    expect(readMarkers(dir)).toEqual(['D', 'D', 'D']);
    const leftovers = fs.readdirSync(dir).filter((f) => f !== 'markers.json');
    expect(leftovers).toEqual([]); // temp file renamed away, not left behind
  });

  it('rejects corrupt JSON as undefined (never throws at resume)', () => {
    fs.writeFileSync(path.join(dir, 'markers.json'), '{not json', 'utf8');
    expect(readMarkers(dir)).toBeUndefined();
  });

  it('rejects a non-array payload as undefined', () => {
    fs.writeFileSync(path.join(dir, 'markers.json'), '{"a":1}', 'utf8');
    expect(readMarkers(dir)).toBeUndefined();
  });
});
