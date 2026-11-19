/**
 * Library file formatting (file-state story): the ONE human-readable
 * bytes formatter, extracted from the Library page (which defined it
 * first) so the Files section, library rows and reports render the
 * same sizes. Dates render through the shared UTC formatter
 * (FavoritesColumns.formatFavoriteDate — the UX-AUDIT L-1 discipline:
 * never the raw toISOString machine format).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
