// Violates exactOptionalPropertyTypes: `undefined` is not assignable to an
// optional property that does not include `| undefined` in its type.
export interface Options {
  label?: string;
}

export function clearLabel(o: Options): void {
  o.label = undefined;
}
