import { describe, it, expect } from 'vitest';
import {
  errorStatusCodesProblem,
  parseErrorStatusCodes,
  updateAdvancedSettingsSchema,
} from './ingress-routes.js';

/**
 * A route's custom error codes go to Traefik's errors middleware as its
 * `status` list. An entry Traefik's admission refuses takes the route's whole
 * IngressRoute reconcile down, and a code below 400 replaces the site's own
 * pages or redirects with an error page. The schema refuses both; these tests
 * also prove the schema is wired to the predicate, not just that it exists.
 */
describe('route custom error codes', () => {
  const save = (codes: string | null) => updateAdvancedSettingsSchema.safeParse({ custom_error_codes: codes });

  it.each(['404', '404,503', '404, 500-599', ' 403 , 410 ', '400-599', '599', '400'])('accepts %j', (codes) => {
    expect(errorStatusCodesProblem(codes)).toBeNull();
    expect(save(codes).success).toBe(true);
  });

  it.each([
    ['200', 'outside 400–599'],
    ['301-404', 'outside 400–599'],
    ['404, 600', 'outside 400–599'],
    ['503-200', 'runs backwards'],
    ['abc', 'not a status code'],
    ['404;503', 'not a status code'],
    ['4040', 'not a status code'],
    ['404,,503', 'empty entry'],
    ['404,', 'empty entry'],
  ])('refuses %j (%s)', (codes, why) => {
    expect(errorStatusCodesProblem(codes)).toContain(why);
    const r = save(codes);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toContain(why);
  });

  it.each([null, '', '  '])('clears with %j, stored as null', (codes) => {
    const r = save(codes);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.custom_error_codes).toBeNull();
  });

  it('leaves the setting alone when the field is absent', () => {
    const r = updateAdvancedSettingsSchema.safeParse({});
    expect(r.success && r.data.custom_error_codes).toBeUndefined();
  });

  it('the predicate itself names a blank list', () => {
    expect(errorStatusCodesProblem('  ')).toContain('at least one status code');
  });

  it('no longer takes a page path: the platform serves the page for each code', () => {
    const r = updateAdvancedSettingsSchema.safeParse({ custom_error_codes: '404', custom_error_path: '/errors/' });
    expect(r.success).toBe(false);
  });

  it('a stored list keeps only the entries Traefik and the platform can use', () => {
    expect(parseErrorStatusCodes('404, not-a-code, 503-200, 500-599, 200, , 503')).toEqual(['404', '500-599', '503']);
  });
});
