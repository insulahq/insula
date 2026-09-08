import { describe, it, expect } from 'vitest';
import {
  siteFolderWithinAppRoot,
  createIngressRouteSchema,
  updateIngressRouteSchema,
} from './ingress-routes.js';

describe('document root must live inside the app root', () => {
  it('accepts the two legitimate shapes', () => {
    expect(siteFolderWithinAppRoot('app', 'app')).toBe(true);            // the common case
    expect(siteFolderWithinAppRoot('app/public', 'app')).toBe(true);     // public/ entry point
    expect(siteFolderWithinAppRoot('app/web/public', 'app')).toBe(true);
  });

  it('rejects a document root outside its sandbox', () => {
    // Would render a vhost whose open_basedir excludes its own DocumentRoot:
    // every request 500s, for a reason three layers from the symptom.
    expect(siteFolderWithinAppRoot('other', 'app')).toBe(false);
    expect(siteFolderWithinAppRoot('../app', 'app')).toBe(false);
  });

  it('is not fooled by a shared name prefix', () => {
    // `app-secrets` starts with `app` but is a SIBLING, not a child.
    expect(siteFolderWithinAppRoot('app-secrets', 'app')).toBe(false);
  });

  it('is vacuously true when either side is absent', () => {
    expect(siteFolderWithinAppRoot(null, 'app')).toBe(true);
    expect(siteFolderWithinAppRoot('app', null)).toBe(true);
  });
});

describe('the request boundary enforces the pair', () => {
  const base = { hostname: 'site.example.test' };

  it('accepts a public/ layout', () => {
    const r = createIngressRouteSchema.safeParse({
      ...base,
      deployment_id: '3fd54013-fc40-4e13-adaf-ed1b5dd39f28',
      site_folder: 'shop/public',
      app_root: 'shop',
    });
    expect(r.success).toBe(true);
  });

  it('refuses a document root outside the app root', () => {
    const r = createIngressRouteSchema.safeParse({
      ...base,
      deployment_id: '3fd54013-fc40-4e13-adaf-ed1b5dd39f28',
      site_folder: 'elsewhere',
      app_root: 'shop',
    });
    expect(r.success).toBe(false);
  });

  it('applies the same rule on update', () => {
    expect(updateIngressRouteSchema.safeParse({ site_folder: 'a/b', app_root: 'a' }).success).toBe(true);
    expect(updateIngressRouteSchema.safeParse({ site_folder: 'x', app_root: 'a' }).success).toBe(false);
  });

  it('still allows clearing both', () => {
    expect(updateIngressRouteSchema.safeParse({ site_folder: null, app_root: null }).success).toBe(true);
  });
});
