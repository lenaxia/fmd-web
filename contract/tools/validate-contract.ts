import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';

/**
 * Validate a contract document against the JSON Schema (draft 2020-12)
 * in contract/schema/contract.schema.json.
 *
 * Pure and offline: both inputs are passed in by the caller so this
 * module never touches the filesystem itself.
 *
 * @returns an empty array when the document is valid, otherwise one
 *          human-readable error string per violation.
 */
export function validateContractDocument(
  document: unknown,
  schema: unknown,
): readonly string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate: ValidateFunction = ajv.compile(
    schema as Parameters<Ajv2020['compile']>[0],
  );
  const valid = validate(document);
  if (valid) {
    return [];
  }
  const errors: readonly ErrorObject[] | null | undefined = validate.errors;
  return (errors ?? []).map(
    (e: ErrorObject): string => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`,
  );
}
