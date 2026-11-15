import { describe, expect, it } from 'vitest';
import { extFromContentType } from '../../../src/jobs/download/image-files.js';

describe('extFromContentType', () => {
  it('maps image content types to their file extension', () => {
    expect(extFromContentType('image/jpeg')).toBe('jpg');
    expect(extFromContentType('image/png')).toBe('png');
    expect(extFromContentType('image/gif')).toBe('gif');
    expect(extFromContentType('image/webp')).toBe('webp');
    expect(extFromContentType('image/bmp')).toBe('bmp');
    expect(extFromContentType('image/avif')).toBe('avif');
  });

  it('parses parameters and casing (Content-Type: image/jpeg; charset=…)', () => {
    expect(extFromContentType('image/jpeg; charset=utf-8')).toBe('jpg');
    expect(extFromContentType('IMAGE/JPEG')).toBe('jpg');
  });

  it('returns the empty string for non-image / unknown types', () => {
    expect(extFromContentType('text/html')).toBe('');
    expect(extFromContentType('application/json')).toBe('');
    expect(extFromContentType('image/jxl')).toBe('');
    expect(extFromContentType('')).toBe('');
  });
});
