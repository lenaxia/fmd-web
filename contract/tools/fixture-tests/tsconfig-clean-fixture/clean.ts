// Positive control: compiles CLEAN under the base strict flags.
// If this file fails, the strict flags themselves are broken, not the
// violating fixtures.
export interface Name {
  readonly value: string;
}

export function greet(n: Name): string {
  return `hi ${n.value}`;
}

export const shout = (n: Name): string => n.value.toUpperCase();
