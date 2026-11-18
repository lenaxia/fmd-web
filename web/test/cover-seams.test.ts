// @vitest-environment jsdom
/**
 * Cover proxy web seams (covers live-defect): the shared coverSrc
 * rewrite (every cover render site routes through it — a CDN url
 * NEVER reaches an <img> behind `img-src 'self' data: blob:`) and the
 * preview-tunnel manifest token (the ?t credential rides the manifest
 * link so its fetch does not 401 through the preview URL; a no-op in
 * production). The No-cover fallback behavior itself is pinned by
 * manga-parity.test.tsx (empty coverLink → placeholder).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { coverSrc } from '../src/api/cover';
import { applyPreviewManifestToken } from '../src/state/preview-manifest';

describe('coverSrc: the one shared cover rewrite', (): void => {
  const MODULE = '0d3653a8d9b747a381374f32e0a1641e';

  it('rewrites an absolute CDN cover url to the same-origin proxy', (): void => {
    const url = 'http://fmcdn.mfcdn.net/store/manga/32761/cover.jpg?token=abc&ttl=1893456000';
    expect(coverSrc(MODULE, url)).toBe(
      `/api/cover?moduleId=${MODULE}&url=${encodeURIComponent(url)}`,
    );
  });

  it('normalizes protocol-relative urls (the FanFox //zjcdn shape) to https before proxying', (): void => {
    expect(coverSrc(MODULE, '//zjcdn.example/cover.jpg')).toBe(
      `/api/cover?moduleId=${MODULE}&url=${encodeURIComponent('https://zjcdn.example/cover.jpg')}`,
    );
  });

  it('passes data:/blob: urls through unchanged (CSP-allowed by design)', (): void => {
    expect(coverSrc(MODULE, 'data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(coverSrc(MODULE, 'blob:https://fixtures.example/cover')).toBe(
      'blob:https://fixtures.example/cover',
    );
  });

  it('yields undefined for absent moduleId or empty url (callers keep the No-cover fallback)', (): void => {
    expect(coverSrc(undefined, 'https://cdn.example/c.jpg')).toBeUndefined();
    expect(coverSrc('', 'https://cdn.example/c.jpg')).toBeUndefined();
    expect(coverSrc(MODULE, undefined)).toBeUndefined();
    expect(coverSrc(MODULE, '')).toBeUndefined();
  });
});

describe('applyPreviewManifestToken: preview-tunnel manifest 401 mitigation', (): void => {
  beforeEach((): void => {
    cleanup();
    document.head.querySelectorAll('link[rel="manifest"]').forEach((link): void => {
      link.remove();
    });
  });

  const installManifest = (href: string): HTMLLinkElement => {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = href;
    document.head.appendChild(link);
    return link;
  };

  it('appends the t param to a root-relative manifest href', (): void => {
    const link = installManifest('/manifest.webmanifest');
    const applied = applyPreviewManifestToken(document, '?t=v1abc123');
    expect(applied).toBe(true);
    expect(link.getAttribute('href')).toBe('/manifest.webmanifest?t=v1abc123');
  });

  it('appends the t param to an absolute manifest href', (): void => {
    const link = installManifest('https://preview.example/app/manifest.webmanifest');
    expect(applyPreviewManifestToken(document, '?t=v1abc123')).toBe(true);
    expect(link.getAttribute('href')).toBe('https://preview.example/app/manifest.webmanifest?t=v1abc123');
  });

  it('replaces an existing t param instead of stacking a second one', (): void => {
    const link = installManifest('/manifest.webmanifest?t=v1old');
    expect(applyPreviewManifestToken(document, '?t=v1new')).toBe(true);
    expect(link.getAttribute('href')).toBe('/manifest.webmanifest?t=v1new');
  });

  it('is a no-op without a t param (production deployments)', (): void => {
    const link = installManifest('/manifest.webmanifest');
    expect(applyPreviewManifestToken(document, '')).toBe(false);
    expect(applyPreviewManifestToken(document, '?q=search')).toBe(false);
    expect(link.getAttribute('href')).toBe('/manifest.webmanifest');
  });

  it('is a no-op with an empty t param or no manifest link', (): void => {
    expect(applyPreviewManifestToken(document, '?t=')).toBe(false);
    expect(applyPreviewManifestToken(document, '?t=v1abc123')).toBe(false);
  });
});
