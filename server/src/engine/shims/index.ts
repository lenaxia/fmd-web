/**
 * Shim registry placeholder (DESIGN.md §5.4–5.7, §11 engine/shims).
 * Each name maps to one compatibility shim implemented in later phases;
 * `pb` is the protobufjs-backed preload shim (D17).
 */

export type ShimName =
  | 'http'
  | 'txquery'
  | 'ixqvalue'
  | 'strings'
  | 'mangainfo'
  | 'postprocess'
  | 'crypto'
  | 'duktape'
  | 'gzip'
  | 'fileutil'
  | 'imagepuzzle'
  | 'pcre2'
  | 'pb'
  | 'antibot'
  | 'sidecar';

export const SHIM_NAMES: readonly ShimName[] = [
  'http', 'txquery', 'ixqvalue', 'strings', 'mangainfo', 'postprocess',
  'crypto', 'duktape', 'gzip', 'fileutil', 'imagepuzzle', 'pcre2',
  'pb', 'antibot', 'sidecar',
];

export function isShimName(value: string): value is ShimName {
  return (SHIM_NAMES as readonly string[]).includes(value);
}
