// Lint violation fixture — checked by contract/test/toolchain.test.ts,
// never by the normal lint pass (see eslint.config.js ignores).
// Violations:
//  - `any` parameter + `any` return  → @typescript-eslint/no-explicit-any
//  - exported function without return type
//    → @typescript-eslint/explicit-module-boundary-types
export function makeThing(input: any): any {
  return input;
}

export function increment(n: number) {
  return n + 1;
}

export const doubler = (n: number) => n * 2;
