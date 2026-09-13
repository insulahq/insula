import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from './errors.js';
import { parseBody } from './validate-body.js';

/** Call parseBody and return the ApiError it threw, failing if it did not throw. */
function expectApiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('expected parseBody to throw an ApiError');
}

describe('parseBody', () => {
  const schema = z.object({
    name: z.string().min(1),
    count: z.number().int().optional(),
  });

  it('returns the parsed data on a valid body', () => {
    expect(parseBody(schema, { name: 'x', count: 2 })).toEqual({ name: 'x', count: 2 });
  });

  it('accepts an empty body when every field is optional', () => {
    expect(parseBody(z.object({ a: z.string().optional() }), undefined)).toEqual({});
  });

  describe('error code, derived so existing callers keep seeing what they saw', () => {
    // Both codes are asserted by existing route tests and by
    // integration-file-manager-bulk-e2e.sh / integration-notifications.sh.
    // Flattening them to one new code would be a silent API change.

    it('reports an ABSENT field as MISSING_REQUIRED_FIELD', () => {
      const e = expectApiError(() => parseBody(schema, {}));
      expect(e.code).toBe('MISSING_REQUIRED_FIELD');
      expect(e.status).toBe(400);
      expect(e.details).toEqual({ field: 'name' });
    });

    it('reports an undefined body as MISSING_REQUIRED_FIELD on the field, not on the body', () => {
      const e = expectApiError(() => parseBody(schema, undefined));
      expect(e.code).toBe('MISSING_REQUIRED_FIELD');
      expect(e.details).toEqual({ field: 'name' });
    });

    it('reports a PRESENT but wrongly-typed field as INVALID_FIELD_VALUE', () => {
      const e = expectApiError(() => parseBody(schema, { name: 123 }));
      expect(e.code).toBe('INVALID_FIELD_VALUE');
      expect(e.details).toEqual({ field: 'name' });
    });

    it('reports a present-but-empty string as INVALID_FIELD_VALUE, not missing', () => {
      // `''` is a value the caller supplied. Calling it "missing" sends them
      // looking for a field they can see in their own request body.
      const e = expectApiError(() => parseBody(schema, { name: '' }));
      expect(e.code).toBe('INVALID_FIELD_VALUE');
    });

    it('reports a bad enum member as INVALID_FIELD_VALUE', () => {
      const s = z.object({ action: z.enum(['enable', 'disable']) });
      const e = expectApiError(() => parseBody(s, { action: 'delete' }));
      expect(e.code).toBe('INVALID_FIELD_VALUE');
      expect(e.details).toEqual({ field: 'action' });
    });

    it('reports an explicit null as INVALID_FIELD_VALUE, not as missing', () => {
      // null is not undefined: the caller sent something.
      const e = expectApiError(() => parseBody(schema, { name: null }));
      expect(e.code).toBe('INVALID_FIELD_VALUE');
    });

    it('does not key off the message text', () => {
      // Zod 4 removed `received` from the issue object — it survives only
      // inside the message ("expected string, received undefined"). A code
      // derived by matching that string would break on a message-format or
      // locale change, silently, and downgrade a missing-field error. This
      // pins the behaviour that the INPUT is what gets asked.
      const nested = z.object({ outer: z.object({ inner: z.string() }) });
      const missing = expectApiError(() => parseBody(nested, { outer: {} }));
      expect(missing.code).toBe('MISSING_REQUIRED_FIELD');
      expect(missing.details).toEqual({ field: 'outer.inner' });

      const wrong = expectApiError(() => parseBody(nested, { outer: { inner: 5 } }));
      expect(wrong.code).toBe('INVALID_FIELD_VALUE');
    });
  });

  describe('strict schemas', () => {
    const strict = z.object({ enabled: z.boolean() }).strict();

    it('rejects an unknown key', () => {
      // The PATCH case. Zod's default STRIPS unknown keys, which is the exact
      // silent-noop this work removes: a misspelled field parses clean and the
      // handler changes nothing while returning 200.
      const e = expectApiError(() => parseBody(strict, { enabled: true, enabledd: false }));
      expect(e.code).toBe('INVALID_FIELD_VALUE');
    });

    it('names the REJECTED KEY, not its parent object', () => {
      // An unrecognized_keys issue has the object as its path, so reporting
      // `first.path` would answer "which field?" with "" and leave the caller
      // hunting for their own typo.
      const e = expectApiError(() => parseBody(strict, { enabled: true, enabeld: false }));
      expect(e.details).toEqual({ field: 'enabeld' });
      expect(e.message).toContain('enabeld');
    });

    it('accepts the body without the unknown key', () => {
      expect(parseBody(strict, { enabled: true })).toEqual({ enabled: true });
    });

    it('demonstrates why .strict() matters — a loose schema accepts the typo', () => {
      // Kept executable rather than as a comment: a non-strict schema is NOT
      // validation against a misspelled field.
      const loose = z.object({ enabled: z.boolean().optional() });
      expect(parseBody(loose, { enabledd: true })).toEqual({});
    });
  });

  describe('arrays', () => {
    const s = z.object({ ids: z.array(z.string().uuid()).min(1) });

    it('names the offending element by index', () => {
      const e = expectApiError(() =>
        parseBody(s, { ids: ['8d7f4e52-1c64-4e3b-9a5f-2f2f6a1b0c11', 42] }),
      );
      expect(e.code).toBe('INVALID_FIELD_VALUE');
      expect(e.details).toEqual({ field: 'ids.1' });
    });

    it('rejects an empty array where the handler requires entries', () => {
      const e = expectApiError(() => parseBody(s, { ids: [] }));
      expect(e.code).toBe('INVALID_FIELD_VALUE');
    });

    it('rejects a non-array where an array is required', () => {
      const e = expectApiError(() => parseBody(s, { ids: 'not-an-array' }));
      expect(e.code).toBe('INVALID_FIELD_VALUE');
    });
  });

  it('omits details when the issue has no path', () => {
    // A top-level type error (body is a string) has an empty path; an
    // empty-string `field` would be worse than none.
    const e = expectApiError(() => parseBody(schema, 'not an object'));
    expect(e.details).toBeUndefined();
    expect(e.message).not.toContain('()');
  });
});
