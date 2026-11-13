// Violates verbatimModuleSyntax: a type imported without the `type` keyword.
import { RemoteThing } from './dep.js';

// Violates noUncheckedIndexedAccess: index access yields string | undefined.
const arr: string[] = ['a'];
const s: string = arr[0].toUpperCase();

// Violates `strict` (noImplicitAny).
export function identity(x) {
  return x;
}

export const out: string = s;
export type UsesRemoteThing = RemoteThing;
