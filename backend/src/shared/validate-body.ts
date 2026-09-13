/**
 * Request-body validation helper (ROADMAP R29a).
 *
 * ## The failure this exists to stop
 *
 * A route that does `request.body as unknown as X` and reads fields off the
 * result does not reject a wrong body — it reads the misspelled field as
 * `undefined` and silently skips whatever that field controlled. The handler
 * then returns **200**. Two shipped bugs came from exactly this:
 * `PATCH /admin/nodes/:name/storage/:diskKey` returned 200 while changing
 * nothing, and the OIDC provider PATCH appeared to rotate a client id it never
 * wrote.
 *
 * A 400 is a bug report. A 200 that changed nothing is a bug that reaches
 * production and gets attributed to the cluster.
 *
 * ## Two rules for authoring the schema you pass in
 *
 * 1. **Author it from what the HANDLER reads, never from what the panel
 *    currently sends.** The panel is one of the two things being checked; a
 *    schema copied from it launders today's drift into the contract and then
 *    makes `tsc` enforce the drift.
 * 2. **Prefer `.strict()` on PATCH.** An unknown key on a PATCH is not an error
 *    anyone notices — it is a field that silently does not change. Zod's default
 *    is to strip unknown keys, which is precisely the silent-noop behaviour
 *    being removed here.
 */
import type { z } from 'zod';
import { ApiError } from './errors.js';

/**
 * Read the value at a Zod issue path, so "was this field absent?" can be asked
 * of the INPUT rather than inferred from the message text.
 *
 * Zod 4 dropped `received` from the issue object — it now exists only inside
 * the human-readable message ("expected string, received undefined"). Keying
 * the error code off that string would break on any message-format change or
 * locale, and would do so silently, downgrading a "you forgot a field" error
 * into a generic one. Asking the input is stable.
 */
function valueAtPath(input: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cur: unknown = input;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

/**
 * Pick the error code the rest of the platform already speaks.
 *
 * The codebase has two established codes for bad input and both are asserted by
 * existing route tests and by `integration-file-manager-bulk-e2e.sh` /
 * `integration-notifications.sh`. Converting hand-rolled checks to Zod must not
 * change what callers see, so the code is derived rather than flattened to a
 * single new one:
 *
 *   - the field is absent          → `MISSING_REQUIRED_FIELD`
 *   - the field is present & wrong → `INVALID_FIELD_VALUE`
 *
 * which is also more useful than one catch-all: those are different mistakes
 * and they send the reader to different places.
 */
function codeForIssue(issue: z.core.$ZodIssue, body: unknown): string {
  if (issue.code === 'invalid_type' && valueAtPath(body, issue.path) === undefined) {
    return 'MISSING_REQUIRED_FIELD';
  }
  return 'INVALID_FIELD_VALUE';
}

/**
 * Parse a request body against a Zod schema, or throw a 400 `ApiError`.
 *
 * The message names the offending path, because the whole point is that the
 * caller learns which field was wrong instead of receiving a 200.
 *
 * @param schema the contract schema; from `@insula/api-contracts`
 * @param body   `request.body` — `undefined` is normalised to `{}` so a schema
 *               whose fields are all optional accepts an empty body, and one
 *               with a required field reports that field rather than "expected
 *               object, received undefined"
 */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const normalised = body ?? {};
  const parsed = schema.safeParse(normalised);
  if (parsed.success) return parsed.data;

  const first = parsed.error.issues[0];
  // On a strict schema the rejected key lives in `keys`, not in `path` — the
  // path of an unrecognized_keys issue is the OBJECT, so reporting it would
  // name the parent and leave the caller hunting for their own typo.
  const path =
    first.code === 'unrecognized_keys' && Array.isArray(first.keys) && first.keys.length > 0
      ? [...first.path, first.keys[0]].join('.')
      : first.path.join('.');

  throw new ApiError(
    codeForIssue(first, normalised),
    path ? `Validation error: ${first.message} (${path})` : `Validation error: ${first.message}`,
    400,
    path ? { field: path } : undefined,
  );
}
