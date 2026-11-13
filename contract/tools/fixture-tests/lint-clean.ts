// Positive control: lints CLEAN under the boundary rules.
export function ok(n: number): number {
  return n;
}

export const okArrow = (s: string): string => s;

// `any` must not appear, even in a private alias:
type UnknownPayload = unknown;

export function parsePayload(p: UnknownPayload): string | undefined {
  if (typeof p === 'object' && p !== null && 'kind' in p) {
    const rec: Record<string, unknown> = p;
    const kind: unknown = rec['kind'];
    return typeof kind === 'string' ? kind : undefined;
  }
  return undefined;
}
