import { describe, it, expect } from 'vitest';
import { createIngressRouteSchema, updateIngressRouteSchema } from './ingress-routes.js';

/**
 * The site folder is validated in three places — the request schema, the
 * service guard, and the renderer. These tests are about the FIRST one.
 *
 * Testing `folderProblem` directly proves the predicate works; it does not
 * prove the schema is wired to it, and a field that is declared but never
 * validated accepts anything while every unit test still passes.
 */
const HOSTILE = [
  '../../etc',
  '..',
  '.',
  '.env',
  '.git',
  'a/../b',
  'sites/../../etc',
  '/etc/passwd',
  'a b',
  'a"b',
  "a'b",
  'a\nDocumentRoot /etc',
  'a;\n}\nserver { root /etc;',
  'a`id`',
  'a$(id)',
  '-leading',
  'a/b/c/d/e',
  'x'.repeat(64),
  '',
];

const base = { hostname: 'example.test', deployment_id: '11111111-1111-4111-8111-111111111111' };

describe('site_folder at the request boundary', () => {
  it.each(HOSTILE)('createIngressRouteSchema rejects %j', (site_folder) => {
    expect(createIngressRouteSchema.safeParse({ ...base, site_folder }).success).toBe(false);
  });

  it.each(HOSTILE)('updateIngressRouteSchema rejects %j', (site_folder) => {
    expect(updateIngressRouteSchema.safeParse({ site_folder }).success).toBe(false);
  });

  /**
   * Names taken from a REAL production tenant, not invented.
   *
   * The original list here was `mysite`, `site-1`, `media/library/2026` — all
   * made up, none with a dot or a capital. A web host's folders are named after
   * the sites they hold, so the first tenant to try this picked `business.na`
   * and got a 400: the picker offered the folder (it exists on disk) and the
   * API refused it. Testing that hostile input is rejected proves nothing about
   * whether ordinary input is accepted.
   */
  it.each([
    ['business.na',        'domain-named folder — the standard shared-hosting convention'],
    ['www.example.com',    'domain with subdomain'],
    ['my.site.co.uk',      'multi-label domain'],
    ['Website',            'capitalised'],
    ['Sites/business.na',  'capitalised parent with a domain child'],
    ['custom-deployment',  'hyphenated'],
    ['my_site',            'underscored'],
    ['0start',             'leading digit'],
    ['mysite',             'plain'],
    ['media/library/2026', 'nested'],
  ])('accepts %j — %s', (site_folder) => {
    const r = createIngressRouteSchema.safeParse({ ...base, site_folder });
    expect(r.success, `expected ${site_folder} to be accepted`).toBe(true);
  });

  it('accepts null to hand the hostname back to the document root', () => {
    expect(createIngressRouteSchema.safeParse({ ...base, site_folder: null }).success).toBe(true);
    expect(updateIngressRouteSchema.safeParse({ site_folder: null }).success).toBe(true);
  });

  it('accepts a route with no site_folder at all', () => {
    // Every route that existed before multi-host omits the field entirely.
    expect(createIngressRouteSchema.safeParse(base).success).toBe(true);
  });

  it('keeps site_folder in the parsed output rather than stripping it', () => {
    // A plain z.object() drops unknown keys, so a field that is declared but
    // mis-named parses cleanly and then vanishes before it reaches the DB —
    // a 200 with no write.
    const parsed = createIngressRouteSchema.safeParse({ ...base, site_folder: 'mysite' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.site_folder).toBe('mysite');
  });
});
